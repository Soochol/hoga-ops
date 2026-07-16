"""In-memory ring buffer for live ticks/snapshots (WS 전환 후 시간 기반 보존).

The live stream publishes ticks/snapshots here; the /api/live/snapshot and
/api/live/series endpoints read from it. ADR-0038: buffer.py is hot-path,
no Parquet imports.

Capacity: time-based eviction (DEFAULT_RETENTION_MS = 15 min) with a
MAX_BUFFER_ENTRIES hard cap as a flood safety pin.

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
  별도 설계(ADR)로 진행한다. 현재 안전핀: MAX_BUFFER_ENTRIES 하드캡 + 시간 eviction +
  drop_codes_except(Live Set 축출 즉시 회수).
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from typing import Iterable

from .snapshot import LiveSnapshot, SnapshotKind

# Eng C5 → WS 전환: 개수 캡은 폭주 안전핀으로만. 실 보존은 시간 기반
# (spec §8 봉합 사이징 불변식: 보존 > 2× HOGA_LIVE_TODAY_PROMOTE_INTERVAL_S).
MAX_BUFFER_ENTRIES = 60_000
DEFAULT_RETENTION_MS = 900_000  # 15분


class LiveBuffer:
    """Per-code, per-kind ring buffer.

    Stores LiveSnapshot.payload dicts (not the dataclass itself) so the
    API layer can serialize directly without an extra conversion step.
    """

    def __init__(self, *, retention_ms: int = DEFAULT_RETENTION_MS) -> None:
        self._retention_ms = retention_ms
        self._lock = asyncio.Lock()
        # Keyed by (code, kind.value) → deque[dict]. deque(maxlen=...) handles
        # FIFO drop automatically when the cap is exceeded.
        self._buf: dict[tuple[str, str], deque[dict]] = {}
        # SSE push: per-code set of subscriber queues.
        self._subscribers: dict[str, set[asyncio.Queue[dict]]] = {}

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
                    d = deque(maxlen=MAX_BUFFER_ENTRIES)
                    self._buf[key] = d
                # Store payload + t_ms + kind together so subscribers know
                # which kind they received. Existing get_latest / get_series
                # helpers strip the `kind` field when building their responses.
                entry = {"t_ms": s.t_ms, "kind": s.kind.value, **s.payload}
                d.append(entry)
                entries.append(entry)
                while d and d[0]["t_ms"] < cutoff:  # 시간 기반 eviction
                    d.popleft()

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
                        pass

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
            "total_entries": sum(per_kind.values()),
            "per_kind": per_kind,
            "codes": codes,
            "subscribers": subscribers,
            "retention_ms": self._retention_ms,
            "max_entries_per_deque": MAX_BUFFER_ENTRIES,
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
                del self._buf[key]

    async def get_series(self, code: str) -> dict:
        """All buffered snapshots for `code` as parallel arrays."""
        async with self._lock:
            ob_buf = self._buf.get((code, SnapshotKind.OB.value))
            tr_buf = self._buf.get((code, SnapshotKind.TRADE.value))
            br_buf = self._buf.get((code, SnapshotKind.BROKER.value))
            snapshots = tuple(ob_buf) if ob_buf else ()
            trades = tuple(tr_buf) if tr_buf else ()
            brokers = tuple(br_buf) if br_buf else ()

        return {
            "code": code,
            "snapshots": [_strip_t_only(e) for e in snapshots],
            "trades": [_strip_t_only(e) for e in trades],
            "brokers": [_strip_t_only(e) for e in brokers],
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
