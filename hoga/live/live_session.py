"""Live Session — KIS WS 연결집합(dynamic-N)의 상태기계.

CONTEXT.md 'Live Session' = Live Set을 수집하는 N개 KIS WS 연결집합 + 그 생명주기.
lifecycle.py에서 strangler 추출(C3, 2026-06-10): streams dict + 전이(start/refresh/
restart/stop) + 불변식(키=account id∈[0,N), exclude-then-subscribe 순서) + WS-health
(degraded_set/status_fields)를 한 객체로 응집한다. lifecycle은 lifespan 오케스트레이션
(poller·today-promoter·watchdog 트리거·get_status 합성)만 남는다.

ADR-0038(hot path): pyarrow/polars import 금지 — promote.py(cold path)만 허용.
이 모듈은 test_adr_invariants._HOT_PATH_MODULES에 등재됨.

step 1(이 커밋): 순수 헬퍼(partition_live_set/_compute_live_set/display_ordered_codes/
live_set_codes) + 상수 + _StreamConn을 이동. LiveSession 객체·오케스트레이션은 후속 단계.
lifecycle은 이름들을 재export해 기존 호출부·테스트가 무수정으로 동작한다.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from .ws_fields import TRS  # 종목당 구독 TR 집합 — 사이징·구독수 단일진실원(경량 leaf)

if TYPE_CHECKING:
    import asyncio
    from collections.abc import Awaitable, Callable

    from hoga.api.models import WatchlistDocument

    _BuildConn = Callable[[int, list[str], Path], "_StreamConn"]
    _TeardownConn = Callable[["_StreamConn"], Awaitable[None]]

_log = logging.getLogger(__name__)


# ── Live Set constants (spec §4·§5.1) ─────────────────────────────────────────

KIS_WS_MAX_REGISTRATIONS = 30   # 연결(appkey)당 실시간 등록 안전 한도. 실측 ~32(가변
                                # 32~39, 2026-06-10 라이브 — 3계좌 78등록 전부ACK로 연결당
                                # 한도 확정, 고객공유 아님) 아래 마진. 옛 41(KIS 문서 가정)은
                                # 실측 불일치 → 폐기. 깨끗한 재측정 후 상향 가능(최대 ~32).
TRS_PER_CODE = len(TRS)         # 사이징=구독수 단일진실원(ws_fields.TRS). 드리프트 불가.
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # 3TR→10, 2TR→15 (계좌당 종목)
# 동적 상한: 13 * n_configured. start에서 n_configured를 곱해 _compute_live_set이 사용.
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX  # 1계좌 기본(_compute_live_set이 n_configured로 동적 절단)


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order 연속 배정: account k = codes[k*W:(k+1)*W], W=_PER_ACCOUNT_MAX (스펙 §5.3, Q4).

    n개 리스트를 항상 반환(후행은 빈 리스트일 수 있음). 연속 슬라이스라
    W-경계를 안 넘는 코드는 계좌 고정 → 재정렬 churn 최소(위험 #4). 해시 배정
    대신 연속을 택한 이유: CONTEXT.md 'top-W=경계' 모델 일치 + explicit>clever.
    """
    return [codes[k * _PER_ACCOUNT_MAX:(k + 1) * _PER_ACCOUNT_MAX] for k in range(n)]


def display_ordered_codes(doc: WatchlistDocument) -> list[str]:
    """Watchlist Panel 표시 순서로 코드 평탄화 (2026-06-06 결정, watchlist v2 폴더화).

    Step 0 확인 (grouping.ts:28-43 + WatchlistDrawer.tsx:222,228):
    - folders[]를 `.order` 오름차순으로 정렬 → 각 폴더의 entry를 `.order` 오름차순
    - 미분류(folder_id=None) 그룹은 **폴더들 뒤** (groupByFolder가 push로 마지막에 추가)
    - 빈 미분류는 WatchlistDrawer가 숨기지만 코드 수집에는 영향 없음

    정렬 키: (folder rank — 미분류는 len(folders), entry.order)
    """
    sorted_folders = sorted(doc.folders, key=lambda f: f.order)
    folder_rank = {f.id: i for i, f in enumerate(sorted_folders)}
    n_folders = len(sorted_folders)

    def _key(entry):  # type: ignore[no-untyped-def]
        rank = folder_rank[entry.folder_id] if entry.folder_id is not None else n_folders
        return (rank, entry.order)

    return [e.code for e in sorted(doc.entries, key=_key)]


def _compute_live_set(data_dir: Path, n_configured: int = 1) -> list[str]:
    """Live Set 산출 파이프라인(start/refresh 공용):
    load_document → 표시 순서 평탄화 → symbol-master 필터(cold cache 무필터
    폴백) → 상위 (13 * n_configured) 절단."""
    from hoga.api import symbols as _symbols  # noqa: PLC0415
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    ordered = display_ordered_codes(load_document(data_dir))
    known = {h.code for h in _symbols.search("", limit=10_000)}
    if known:
        dropped = [c for c in ordered if c not in known]
        if dropped:
            _log.warning("live.stream.codes_unknown dropped=%r", dropped)
        ordered = [c for c in ordered if c in known]
    return ordered[: _PER_ACCOUNT_MAX * n_configured]


def live_set_codes(doc: WatchlistDocument) -> list[str]:
    """Live Set = 표시 순서 상위 LIVE_SET_MAX_CODES(=W) (테스트 전용 — 실경로는 _compute_live_set).

    CONTEXT.md 'Live Set', 그릴링 Q3 + 2026-06-06 개정.
    """
    return display_ordered_codes(doc)[:LIVE_SET_MAX_CODES]


# ── Stream connection (한 KIS 계좌의 WS 연결 묶음) ──────────────────────────────

@dataclass
class _StreamConn:
    """한 KIS 계좌의 WS 연결 묶음 (dynamic-N: codes 항상 비어있지 않음)."""
    account_id: int
    stream_obj: object            # LiveStream — 자체 writer 소유, code-disjoint
    ws_task: asyncio.Task       # type: ignore[type-arg]
    flush_task: asyncio.Task    # type: ignore[type-arg]
    codes: tuple[str, ...]


# ── 캡처 헬스 단일 술어 (watchdog + status 공유) ────────────────────────────────

def _capture_health(
    *, running: bool, ws: object | None, now_ms: int, ref_ms: int,
    stale_after_ms: int, market_closed: bool,
) -> tuple[bool, str]:
    """캡처 헬스 단일 술어(spec 2026-06-08 §2.2) — watchdog과 status_fields가 공유.

    last_recv 단독은 구독이 죽어도 PINGPONG이 갱신해 거짓-그린(리뷰 #4),
    last_tick 단독은 한산한 종목을 거짓-레드로 만든다. 그래서 '구독 확인 +
    수신 신선도'를 결합한다. ref_ms = max(started, session_open) — 세션 기준
    grace 시작점(watchdog과 동일).

    체크 순서가 핵심(advisor B): recv(stale)를 sub보다 먼저 본다 — sub 미확인
    이어도 수신이 끊겼으면 dead socket이라 'stale'(watchdog 재시작), 수신이
    신선하면 'sub_failed'(appkey 거부류 — 재연결 불응, 가시화만)로 갈린다.
    """
    if not running or ws is None:
        return (False, "offline")
    if market_closed:
        return (False, "closed")
    if not getattr(ws, "connected", False):
        return (False, "reconnecting")
    grace_elapsed = (now_ms - ref_ms) > stale_after_ms
    last_recv = getattr(ws, "last_recv_ms", None)
    recv_stale = grace_elapsed and (
        last_recv is None or (now_ms - last_recv) > stale_after_ms
    )
    if recv_stale:
        return (False, "stale")
    expected = getattr(ws, "sub_expected", 0)
    acked = getattr(ws, "sub_acked", 0)
    if expected > 0 and acked < expected:
        return (False, "sub_failed" if grace_elapsed else "subscribing")
    return (True, "healthy")


# ── Live Session (WS 연결집합 상태기계) ─────────────────────────────────────────

class LiveSession:
    """KIS WS 연결집합(dynamic-N)의 상태 — streams + 세션 스코프 불변식 소유.

    streams 키 ∈ [0, n_configured). lifecycle의 _state.session이 보유. 전이는 메서드:
    start(빈 streams 전제로 파티션별 conn 빌드) / refresh(원자 활성집합 스왑 + WS 재구독
    diff) / restart(죽은 conn 1개 격리 복구) / stop(전체 teardown).

    의존성 주입: conn 빌드/teardown은 lifecycle이 _buffer·_now_ms·_today_kst 등 프로세스
    리소스로 만드는 I/O 프리미티브라, 메서드 파라미터로 주입한다(build_conn/teardown_conn).
    이로써 LiveSession은 lifecycle 전역에 의존하지 않는다(순환·모듈 로드 순서 회피).

    exclude-then-subscribe 순서(ADR-0067 §5.5)는 poller가 lifecycle 소유라 lifecycle의
    락 메서드가 _sync_exclusion(poller) 후 start/refresh를 호출해 봉인한다(C3 설계 ①).
    step 3(이 커밋): start/refresh/restart/stop 이전. degraded_set/status_fields는 step 4.
    """

    def __init__(self) -> None:
        self.streams: dict[int, _StreamConn] = {}
        self.started_at_ms: int | None = None
        self.n_configured: int = 0
        self.live_set: tuple[str, ...] = ()
        self.watchlist_codes: tuple[str, ...] = ()

    async def stop(self, teardown_conn: _TeardownConn) -> None:
        """현재 conn들만 teardown(R1: KisClient는 보존). streams 비움."""
        for conn in list(self.streams.values()):
            await teardown_conn(conn)
        self.streams.clear()

    async def start(
        self,
        *,
        codes: list[str],
        n_configured: int,
        data_dir: Path,
        now_ms: int,
        build_conn: _BuildConn,
    ) -> None:
        """코드 있는 파티션만 conn 생성(dynamic-N; 빈 part=연결 없음 → C4).

        호출 전 stop()으로 streams가 비어 있어야 한다 — lifecycle이 exclude-then-
        subscribe 순서(stop → ensure_poller → _sync_exclusion → start)로 보장한다.
        """
        parts = partition_live_set(list(codes), n_configured)
        streams: dict[int, _StreamConn] = {}
        for account_id, part in enumerate(parts):
            if part:
                streams[account_id] = build_conn(account_id, part, data_dir)
        self.streams = streams
        self.started_at_ms = now_ms
        self.n_configured = n_configured
        self.live_set = tuple(codes)
        self.watchlist_codes = tuple(codes)

    async def refresh(
        self,
        *,
        codes: list[str],
        data_dir: Path,
        build_conn: _BuildConn,
        teardown_conn: _TeardownConn,
    ) -> None:
        """watchlist 변경 후 dynamic-N create/update/teardown (스펙 §5.5).

        Pass 0(동기, await 없음): 기존 conn들의 on_tick 활성집합을 새 파티션으로 **원자
        스왑**. cross-boundary 이동(코드가 13-경계를 넘어 conn↔conn 이동) 시, 옛 conn
        활성집합에서 빠진 뒤 새 conn에 들어가야 두 writer가 같은 {date}/{code}.jsonl에
        동시 append하는 이중-write 창이 안 생긴다. set_active_codes는 동기라 이 루프 중엔
        틱이 처리되지 않아 스왑이 원자적. (Pass 1의 async WS 재구독에서 코드가 잠시 양쪽
        WS에 구독돼도 on_tick 활성 필터가 이미 정확하므로 write는 한 conn으로만 간다.)
        """
        parts = partition_live_set(list(codes), self.n_configured)

        # Pass 0 (동기): 활성집합 원자 스왑
        for account_id, part in enumerate(parts):
            conn = self.streams.get(account_id)
            if conn is not None:
                conn.stream_obj.set_active_codes(set(part))   # type: ignore[attr-defined]

        # Pass 1 (async): WS 구독 diff + build/teardown
        for account_id, part in enumerate(parts):
            conn = self.streams.get(account_id)
            if part and conn is not None:
                await conn.stream_obj.ws.update_codes(part)      # type: ignore[attr-defined]
                self.streams[account_id] = _StreamConn(
                    account_id=account_id, stream_obj=conn.stream_obj,
                    ws_task=conn.ws_task, flush_task=conn.flush_task,
                    codes=tuple(part),
                )
            elif part and conn is None:
                self.streams[account_id] = build_conn(account_id, part, data_dir)
            elif not part and conn is not None:
                await teardown_conn(conn)
                self.streams.pop(account_id, None)

        live_set = tuple(codes)
        self.live_set = live_set
        self.watchlist_codes = live_set

    async def restart(
        self,
        account_id: int,
        *,
        data_dir: Path,
        build_conn: _BuildConn,
        teardown_conn: _TeardownConn,
    ) -> None:
        """죽은 conn 하나만 격리 복구(스펙 §5.6, Q6). R1: KisClient 보존. 현재 파티션으로
        재계산해 그 사이 watchlist 변화 흡수(축소됐으면 conn을 rebuild 대신 pop)."""
        conn = self.streams.get(account_id)
        if conn is None:
            return
        n = self.n_configured
        parts = partition_live_set(_compute_live_set(data_dir, n), n)
        codes = parts[account_id] if account_id < len(parts) else []
        await teardown_conn(conn)
        if codes:
            self.streams[account_id] = build_conn(account_id, codes, data_dir)
        else:
            self.streams.pop(account_id, None)   # 그 사이 watchlist 축소됨

    # ── 캡처 헬스 / status (get_status·account_health WS-probe 공유) ──────────────

    def _capture_status(
        self, *, now_ms: int, market_closed: bool, stale_after_ms: int,
    ) -> tuple[bool, str, list[int]] | None:
        """WS 연결집합 캡처 헬스 — (cap_healthy, cap_reason, degraded id 정렬) | None(streams
        없음). market_closed(전역 장 마감)는 per-conn 루프 밖에서 단락 — 계좌별 결함이 아니라
        전역 상태라, 안 그러면 밤/주말마다 모든 conn이 degraded로 잡히는 거짓 신호(advisor 버그
        회피). 정규장이면 conn별 _capture_health 집계, cap_reason=worst(마지막 비정상, Q10 값 불변).

        get_status(표시: cap_healthy/reason/degraded)와 account_health WS-probe(라우팅: degraded
        집합)가 이 단일 계산을 공유한다(중복 제거)."""
        if self.started_at_ms is None or not self.streams:
            return None
        if market_closed:
            return (False, "closed", [])
        from datetime import datetime  # noqa: PLC0415

        from .kis_client import KIS_KST  # noqa: PLC0415
        kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
        session_open_ms = int(
            kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
        )
        ref_ms = max(self.started_at_ms, session_open_ms)
        cap_healthy, cap_reason, degraded = True, "healthy", []
        for account_id, conn in self.streams.items():
            ws = getattr(conn.stream_obj, "ws", None)
            healthy, reason = _capture_health(
                running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
                stale_after_ms=stale_after_ms, market_closed=False,
            )
            if not healthy:
                cap_healthy = False
                cap_reason = reason
                degraded.append(account_id)
        degraded.sort()
        return (cap_healthy, cap_reason, degraded)

    def degraded_set(
        self, *, now_ms: int, market_closed: bool, stale_after_ms: int,
    ) -> set[int]:
        """WS-저하 account 집합 — account_health WS-probe의 구현체(C2 합류 귀착점).
        streams 없음/전역 장 마감 → 빈 집합(라우팅 안 막음)."""
        cap = self._capture_status(
            now_ms=now_ms, market_closed=market_closed, stale_after_ms=stale_after_ms,
        )
        return set() if cap is None else set(cap[2])

    def status_fields(
        self, *, now_ms: int, market_closed: bool, stale_after_ms: int,
    ) -> dict:
        """get_status용 streams-파생 필드(dict). running의 poller.alive OR-항·idle/offline·
        today-promote 합성은 lifecycle.get_status가 담당. capture=None이면 streams 없음
        (get_status가 poller-only running과 결합해 idle/offline 해석)."""
        streams = self.streams
        streams_running = any(not c.ws_task.done() for c in streams.values())
        ws_connected = bool(streams) and all(
            getattr(getattr(c.stream_obj, "ws", None), "connected", False)
            for c in streams.values()
        )
        ticks = [
            t for c in streams.values()
            if (t := getattr(getattr(c.stream_obj, "ws", None), "last_tick_ms", None)) is not None
        ]
        return {
            "streams_running": streams_running,
            "ws_connected": ws_connected,
            "last_tick_ms": max(ticks) if ticks else None,
            "started_at_ms": self.started_at_ms,
            "watchlist_count": len(self.watchlist_codes),
            "live_set": list(self.live_set),
            "capture": self._capture_status(
                now_ms=now_ms, market_closed=market_closed, stale_after_ms=stale_after_ms,
            ),
        }
