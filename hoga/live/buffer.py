"""In-memory ring buffer for live ticks/snapshots (WS 전환 후 시간 기반 보존).

The live stream publishes ticks/snapshots here; the /api/live/snapshot and
/api/live/series endpoints read from it. ADR-0038: buffer.py is hot-path,
no Parquet imports.

Capacity: time-based eviction (DEFAULT_RETENTION_MS = 15 min) with a per-deque
hard cap (:func:`cap_for_retention`) as a flood safety pin.

메모리 실측 (2026-07-30, `live_kiwoom/20260729` · 243종목 947MB 를 이 버퍼에 재생):
  - 엔트리당 tracemalloc 2,407B / VmRSS 2,576B
  - (code,kind) 당 15분 창 = **90~91개**. `stream.py:FLUSH_INTERVAL_S = 10.0` 의
    함수라 **시장 활동과 무관**하다(활동이 폭발해도 이 수는 안 변한다).
  - 종목당 1.15MiB → 235종목 262MiB · 800종목 894MiB (VmRSS, gc 후 current)
  - kind 비중: ob 49% · broker 31% · trade 13% · fill 5% · candle 2%
  즉 이 버퍼의 메모리는 종목 수의 **선형 함수**다 — 어느 날 갑자기 터지는 종류가
  아니라 종목 수를 늘리면 그만큼 늘어나는 예측 가능한 비용이다.
  (측정 시 주의: `ru_maxrss`(peak) + 측정용 임시객체 churn 을 쓰면 같은 코드가
  2.4배로 나온다 — 보유량은 gc 후 VmRSS(current) 로 봐야 한다.)

Concurrency: a single asyncio.Lock guards all mutations and reads.
Readers grab a frozen tuple snapshot of the deque under the lock, then
release before processing — keeps the critical section short.

Scaling ceiling (ADR-0116 리뷰 Major, 유예/검토 — 실측 후 후속 PR):
  이 버퍼는 **표시 전용**(/api/live/snapshot·/series). 저장 경로는 LiveStream의
  writer(JSONL→promote→parquet)라 버퍼와 무관하다. 그런데 on_tick은 자기 구독 집합
  전체를 publish하므로, 키움 WS(히트맵, 최대 200×4=800종목)가 붙으면 KIS와 공유하는
  이 인스턴스에 800종목이 per-tick으로 쌓인다 — 실제로 화면에 조회 중인 건 1종목뿐인데
  나머지 799종목이 보존창(15분)만큼 dead-weight로 남는다(OB 엔트리 ~수 KB × 수백~수천/
  종목 → 수 GB 가능).
  naive 완화(미구독 종목 보존창 단축)는 사이징 불변식(보존 > 2× promote_interval;
  기본 promote 300s → 바닥 600s)에 막혀 900→600s(33%)뿐이라 효과가 작다. 근본 해법은
  '구독(조회) 종목만 버퍼링 + 첫 조회 시 backfill' 인데, 첫 조회 intraday tail이 최대
  promote_interval만큼 비는 UX 트레이드오프가 있어 4×200 실규모 활성화 시 부하 실측 후
  별도 설계(ADR)로 진행한다. 현재 안전핀: per-deque 하드캡 + 시간 eviction +
  drop_codes_except(Live Set 축출 즉시 회수).

  **남은 갭**: per-deque 캡은 전역 예산이 아니다. deque 수가 종목 수에 비례하므로
  전체 상한 = 종목 × kind × 캡 이고, 기본값·800종목이면 최악 ~3.7GiB 다
  (60,000 캡 시절엔 538GiB 였다 — 즉 안전핀이 발화할 수 없는 위치에 있었다).
  전역 예산은 "초과 시 어느 deque 를 줄일지" 라는 축출 정책이 필요해 별개 설계다.
"""

from __future__ import annotations

import asyncio
import math
import time
from collections import deque
from collections.abc import Iterable

from .snapshot import LiveSnapshot, SnapshotKind

DEFAULT_RETENTION_MS = 900_000  # 15분

# 한 flush 가 (code,kind) 당 엔트리 1개를 만든다 — `stream.py` 의 `FLUSH_INTERVAL_S`
# 와 **같은 값이어야 한다**. stream 이 buffer 를 import 하므로 역방향 import 는
# 순환이라 여기 복제하고, 드리프트는 테스트가 막는다
# (`test_buffer_flush_interval_matches_stream`).
BUFFER_FLUSH_INTERVAL_MS = 10_000

# 폭주 안전핀 배수. 실측(2026-07-30, live_kiwoom/20260729 · 243종목)에 근거한다:
#   - (code,kind) 당 15분 창 정상상태 = **90~91개** (보존창 ÷ flush 주기와 정확히 일치)
#   - 한 flush 창 안 버스트 = ob·fill·broker·trade 최대 2개(창 경계 정렬),
#     candle 만 최대 11개(분봉 합성 backfill)
#   → 실 피크는 정상상태 + 버스트 ≈ 101. 4배(=360)면 닿지 않는다.
BUFFER_CAP_SAFETY_FACTOR = 4


def cap_for_retention(retention_ms: int) -> int:
    """보존창이 함의하는 엔트리 수 × 안전배수 = deque 당 하드캡.

    **보존창에서 파생하는 이유**: 고정 상수로 두면 누군가 `retention_ms` 를 올릴 때
    캡이 조용히 실제 보존량을 잘라낸다(1시간 보존 = 360개인데 캡이 360이면 경계에서
    바로 물린다). 파생시켜 두면 "캡은 항상 보존량의 N배" 라는 불변식이 유지된다.

    이전에는 `MAX_BUFFER_ENTRIES = 60_000` 고정이었다. 실측 피크가 deque 당 91개라
    **660배 느슨**했고, 그 상한에 닿는 상황이면 800종목 기준 메모리가 이미 538GiB —
    프로세스가 훨씬 전에 죽는다. 즉 "폭주 안전핀" 이 절대 발화할 수 없는 위치에
    박혀 있었다(있다는 사실이 대비돼 있다는 착각만 줬다).

    주의: **이건 전역 예산이 아니다.** deque 수가 종목 수에 비례하므로(종목 × kind)
    전체 상한 = 종목수 × kind수 × 캡 이다. 기본 보존창·800종목 기준 최악
    800 × 5 × 360 × 2.6KB ≈ 3.7GiB(이전 538GiB). 진짜 전역 예산은 축출 정책이
    필요한 별개 설계이고 미결이다 — 실측 근거는 세션 기록 참고.
    """
    expected = max(1, math.ceil(retention_ms / BUFFER_FLUSH_INTERVAL_MS))
    return expected * BUFFER_CAP_SAFETY_FACTOR


# 기본 보존창(15분)에서의 실효 캡 = 90 × 4 = 360. 이름은 유지하되 의미가
# "고정 상한" 에서 "**기본 보존창에서의** 상한" 으로 좁아졌다 — 인스턴스가 쓰는 값은
# `LiveBuffer.max_entries_per_deque` 다(보존창이 다르면 값도 다르다).
MAX_BUFFER_ENTRIES = cap_for_retention(DEFAULT_RETENTION_MS)


class LiveBuffer:
    """Per-code, per-kind ring buffer.

    Stores LiveSnapshot.payload dicts (not the dataclass itself) so the
    API layer can serialize directly without an extra conversion step.
    """

    def __init__(self, *, retention_ms: int = DEFAULT_RETENTION_MS) -> None:
        self._retention_ms = retention_ms
        # 보존창에서 파생한 하드캡 — 근거는 cap_for_retention docstring.
        self._max_entries = cap_for_retention(retention_ms)
        self._lock = asyncio.Lock()
        # Keyed by (code, kind.value) → deque[dict]. deque(maxlen=...) handles
        # FIFO drop automatically when the cap is exceeded.
        self._buf: dict[tuple[str, str], deque[dict]] = {}
        # SSE push: per-code set of subscriber queues.
        self._subscribers: dict[str, set[asyncio.Queue[dict]]] = {}
        self._total_entries = 0
        self._published_total = 0
        self._subscriber_drops = 0
        self._high_water_entries = 0

    def subscribe(self, code: str) -> asyncio.Queue[dict]:
        """Subscribe to publishes for `code`. Returns a queue.

        Each entry pushed to the queue is a dict with at minimum
        ``t_ms`` and ``kind`` keys plus whatever payload fields the
        snapshot carries.
        """
        q: asyncio.Queue[dict] = asyncio.Queue(maxsize=1024)
        self._subscribers.setdefault(code, set()).add(q)
        return q

    def unsubscribe(self, code: str, q: asyncio.Queue[dict]) -> None:
        """Remove a previously subscribed queue. Safe to call if already removed."""
        subs = self._subscribers.get(code)
        if subs is not None:
            subs.discard(q)
            if not subs:
                self._subscribers.pop(code, None)

    async def publish(
        self,
        code: str,
        snapshots: Iterable[LiveSnapshot],
        *,
        now_ms: int | None = None,
    ) -> None:
        if now_ms is None:
            now_ms = int(time.time() * 1000)
        cutoff = now_ms - self._retention_ms
        entries: list[dict] = []
        async with self._lock:
            for s in snapshots:
                key = (code, s.kind.value)
                d = self._buf.get(key)
                if d is None:
                    d = deque(maxlen=self._max_entries)
                    self._buf[key] = d
                # Store payload + t_ms + kind together so subscribers know
                # which kind they received. Existing get_latest / get_series
                # helpers strip the `kind` field when building their responses.
                entry = {"t_ms": s.t_ms, "kind": s.kind.value, **s.payload}
                before = len(d)
                d.append(entry)
                self._total_entries += len(d) - before
                self._published_total += 1
                entries.append(entry)
                while d and d[0]["t_ms"] < cutoff:  # 시간 기반 eviction
                    d.popleft()
                    self._total_entries -= 1
                self._high_water_entries = max(
                    self._high_water_entries,
                    self._total_entries,
                )

        # Notify subscribers AFTER releasing the lock so slow consumers don't
        # block the publisher. Bounded queues drop on overflow.
        subs = self._subscribers.get(code)
        if subs:
            for entry in entries:
                for q in list(subs):
                    try:
                        q.put_nowait(entry)
                    except asyncio.QueueFull:
                        # Subscriber is too slow — drop this entry rather than
                        # blocking. Subscribers can recover via get_series() if
                        # they need the missing data.
                        self._subscriber_drops += 1

    async def stats_snapshot(self) -> dict[str, object]:
        """Size-only observability. A ring buffer has no hit/miss — it always
        serves what it holds — so this reports occupancy, not a hit rate."""
        async with self._lock:
            per_kind: dict[str, int] = {}
            for (_code, kind), d in self._buf.items():
                per_kind[kind] = per_kind.get(kind, 0) + len(d)
            codes = len({code for (code, _kind) in self._buf})
            subscribers = sum(len(s) for s in self._subscribers.values())
        return {
            "total_entries": self._total_entries,
            "published_total": self._published_total,
            "subscriber_drops": self._subscriber_drops,
            "high_water_entries": self._high_water_entries,
            "per_kind": per_kind,
            "codes": codes,
            "subscribers": subscribers,
            "retention_ms": self._retention_ms,
            "max_entries_per_deque": self._max_entries,
        }

    async def get_latest(self, code: str) -> dict | None:
        """Latest snapshot across all three kinds, as a flat response dict.

        Returns None if no snapshots have ever been published for `code`.
        """
        async with self._lock:
            ob_buf = self._buf.get((code, SnapshotKind.OB.value))
            tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
            br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
            if not ob_buf and not tr_buf and not br_buf:
                return None
            latest_ob = ob_buf[-1] if ob_buf else None
            latest_tr = tr_buf[-1] if tr_buf else None
            latest_br = br_buf[-1] if br_buf else None

        # Choose the most recent t_ms across kinds for the response anchor.
        candidates = [e for e in (latest_ob, latest_tr, latest_br) if e is not None]
        if not candidates:
            return None
        t_ms = max(e["t_ms"] for e in candidates)
        return {
            "code": code,
            "t_ms": t_ms,
            "phase": _phase_of(latest_ob or latest_tr or latest_br),
            "orderbook": _strip_meta(latest_ob),
            "recent_trades": _trades_list(latest_tr),
            "brokers": _strip_meta(latest_br),
        }

    async def drop_codes_except(self, keep: set[str]) -> None:
        """Live Set 축출 코드의 deque 해제(Task 4 리뷰 Minor 3) —
        다운샘플러 set_active_codes와 동일 원칙(떠난 종목은 ring에서도 제거).

        조용한 deque(틱이 없는 코드)는 publish 경로의 eviction이 도달하지
        않아 per-tick 유량에서 종목당 ~수십 MB가 영구 잔존할 수 있다.
        명시 해제로 Live Set 축출 즉시 메모리를 회수한다.
        """
        async with self._lock:
            for key in [k for k in self._buf if k[0] not in keep]:
                self._total_entries -= len(self._buf[key])
                del self._buf[key]

    async def get_series(self, code: str) -> dict:
        """All buffered snapshots for `code` as parallel arrays."""
        async with self._lock:
            ob_buf = self._buf.get((code, SnapshotKind.OB.value))
            tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
            br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
            pr_buf = self._buf.get((code, SnapshotKind.PROGRAM.value))
            snapshots = tuple(ob_buf) if ob_buf else ()
            trades = tuple(tr_buf) if tr_buf else ()
            brokers = tuple(br_buf) if br_buf else ()
            programs = tuple(pr_buf) if pr_buf else ()

        return {
            "code": code,
            "snapshots": [_strip_t_only(e) for e in snapshots],
            "trades": [_strip_t_only(e) for e in trades],
            "brokers": [_strip_t_only(e) for e in brokers],
            "programs": [_strip_t_only(e) for e in programs],
        }


def _phase_of(entry: dict | None) -> str:
    if entry is None:
        return "regular"
    return entry.get("phase", "regular")


def _strip_meta(entry: dict | None) -> dict | None:
    """Drop t_ms / phase / kind from a payload-merged entry for the spot response."""
    if entry is None:
        return None
    return {k: v for k, v in entry.items() if k not in ("t_ms", "phase", "kind")}


def _trades_list(entry: dict | None) -> list[dict]:
    if entry is None:
        return []
    return list(entry.get("trades", []))


def _strip_t_only(entry: dict) -> dict:
    """Return the entry as-is (t_ms is part of the shape consumers expect)."""
    return dict(entry)
