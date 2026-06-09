"""Live Capture lifecycle singleton.

Owns the single in-process LiveStream instance and exposes a stable
`get_status()` callable for the API layer.

Lifecycle: ``start_live_stream`` / ``stop_live_stream`` / ``refresh_live_stream``
— KIS WebSocket path (Task 11; REST poller는 Task 13에서 은퇴, 2026-06-06).

``get_status()`` is always safe to call and returns defaults before anything
starts so ``/api/live/status`` works at any time.

Single-worker invariant: see ADR-0038. The module-level singleton is
safe because hoga/live/__init__.py asserts UVICORN_WORKERS == 1 at
import time.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from hoga.api.models import WatchlistDocument
    from .rest_poller import LiveRestPoller

from pydantic import BaseModel, Field

from . import kis_runtime  # needed by reset_for_tests() + start_live_stream
from .buffer import LiveBuffer
from .promote import promote_today

_log = logging.getLogger(__name__)


# ── Live Set constants (spec §4·§5.1) ─────────────────────────────────────────

KIS_WS_MAX_REGISTRATIONS = 41   # appkey당, (tr_id, code) 쌍 기준 — spec §4 검증 완료
TRS_PER_CODE = 3                # 호가 + 체결 + 회원사(H0STMBC0)
_PER_ACCOUNT_MAX = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 13 (계좌당 한도)
# 동적 상한: 13 * n_configured. start에서 n_configured를 곱해 _compute_live_set이 사용.
LIVE_SET_MAX_CODES = _PER_ACCOUNT_MAX  # 1계좌 기본(_compute_live_set이 n_configured로 동적 절단)


def partition_live_set(codes: list[str], n: int) -> list[list[str]]:
    """display-order 연속 배정: account k = codes[k*13:(k+1)*13] (스펙 §5.3, Q4).

    n개 리스트를 항상 반환(후행은 빈 리스트일 수 있음). 연속 슬라이스라
    13-경계를 안 넘는 코드는 계좌 고정 → 재정렬 churn 최소(위험 #4). 해시 배정
    대신 연속을 택한 이유: CONTEXT.md 'top-13=경계' 모델 일치 + explicit>clever.
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
    """Live Set = 패널 표시 순서 상위 13 (테스트 전용 헬퍼 — 실경로는 _compute_live_set) (CONTEXT.md 'Live Set', 그릴링 Q3 + 2026-06-06 개정)."""
    return display_ordered_codes(doc)[:LIVE_SET_MAX_CODES]


# ── Wire model ─────────────────────────────────────────────────────────────────

class LiveStatus(BaseModel):
    """Wire model for GET /api/live/status (spec §6)."""

    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    # WS 전환 후 의미(Task 11 리뷰 이월 문서화): "수집이 활성인 종목 수" =
    # len(live_set) ≤ 13. 원의미("폴러가 순회하는 종목 수")의 자연 승계 —
    # watchlist 전체 수가 아니다(그건 GET /api/watchlist). 프론트는 의도적으로
    # 이 필드를 비소비(useLiveBannerState.ts 주석 참조).
    watchlist_count: int
    # poller-era 필드(wire 호환 유지): WS 전환 후 캡처 경로는 REST를 쓰지
    # 않으므로 0/None 고정. quote 오버레이·캔들 시드의 REST 콜은 비집계.
    # 프론트 소비 0 — 차기 wire 정리 때 제거 후보.
    kis_calls_today: int
    kis_rate_limit_remaining: int | None
    # ADR-0043 / design-review B2 — last successful Today Promotion per code (epoch ms).
    # Empty dict means no promotion has occurred yet this session.
    today_promote_last_ms: dict[str, int] = Field(default_factory=dict)
    # Task 11 additions — WS transport info (unknown keys are safely ignored by frontend)
    transport: str = "ws"
    ws_connected: bool = False
    live_set: list[str] = Field(default_factory=list)
    # Q10 (출시2) — 저하 계좌 id 목록(additive; capture_reason 값은 불변).
    # 프론트는 미소비(C3가 per-code 배지로 소비) — unknown 필드라 무시 안전.
    degraded_accounts: list[int] = Field(default_factory=list)
    # 캡처 헬스(spec 2026-06-08 §2.2) — cycle_lag_ms를 대체하는 정직한 신호.
    capture_healthy: bool = True
    capture_reason: str = "offline"


# ── State ──────────────────────────────────────────────────────────────────────

@dataclass
class _StreamConn:
    """한 KIS 계좌의 WS 연결 묶음 (dynamic-N: codes 항상 비어있지 않음)."""
    account_id: int
    stream_obj: object            # LiveStream — 자체 writer 소유, code-disjoint
    ws_task: "asyncio.Task"       # type: ignore[type-arg]
    flush_task: "asyncio.Task"    # type: ignore[type-arg]
    codes: tuple[str, ...]


@dataclass
class _State:
    """In-process state of the live stream. Mutated only via this module."""

    started_at_ms: int | None = None
    n_configured: int = 0                          # start에 1회 산출·캐시(Q5)
    watchlist_codes: tuple[str, ...] = field(default_factory=tuple)
    # dynamic-N: account_id 키 연결 dict (Task 7이 채움)
    streams: dict[int, _StreamConn] = field(default_factory=dict)
    live_set: tuple[str, ...] = field(default_factory=tuple)
    rest_poller: "LiveRestPoller | None" = None


_state = _State()
_buffer = LiveBuffer()

# Task 11 리뷰 이월: start/stop/refresh의 await 경계에서 _state 교체가 interleave
# 되지 않도록 직렬화. start가 내부에서 stop을 부르므로(재진입) 잠금 없는
# `_stop_live_stream_locked`를 공유한다 — 공개 stop만 락을 잡는다.
_lifecycle_lock = asyncio.Lock()

# ADR-0043 / design-review B2 — in-memory dict of code → last successful
# Today Promotion epoch_ms. Populated by promote_today via
# record_today_promote_success; surfaced via LiveStatus.
_today_promote_last_ms: dict[str, int] = {}


def record_today_promote_success(code: str, t_ms: int) -> None:
    """Called by promote_today on success; surfaced via LiveStatus (ADR-0043)."""
    _today_promote_last_ms[code] = t_ms


def get_today_promote_last_ms() -> dict[str, int]:
    """Snapshot of last successful Today Promotion epoch_ms per code."""
    return dict(_today_promote_last_ms)


def get_active_codes() -> list[str]:
    """Return currently active Live Set codes the stream is capturing.

    Empty list if nothing has started or all stopped.

    Contract (eng-review Blocker 2): readers receive a snapshot at call time —
    `_state.watchlist_codes` is read synchronously. `start_today_promoter`
    (ADR-0043) calls this each cycle (every `interval_s` seconds), so
    watchlist mutations through `start_live_stream`
    (which rebuild `_state`) propagate immediately to the next cycle —
    no caching, no stale closure.
    """
    return list(_state.watchlist_codes)


def get_buffer() -> LiveBuffer:
    return _buffer


def _now_ms() -> int:
    return int(time.time() * 1000)


def _today_kst() -> str:
    from datetime import datetime, timedelta, timezone  # noqa: PLC0415

    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


def _build_conn(account_id: int, codes: list[str], data_dir: Path) -> _StreamConn:
    """한 계좌의 WS 연결 묶음 생성 (스펙 §5.2). 호출자(start/refresh/watchdog)는
    account_id ∈ configured_account_ids 임을 보장하므로 client는 non-None.

    각 conn은 자체 LiveStream+LiveWriter(code-disjoint라 (date,code) 충돌 없음).
    공유: 단일 _buffer. KisClient는 kis_runtime의 account별 싱글톤(재사용)."""
    from .stream import LiveStream  # noqa: PLC0415
    from .writer import LiveWriter  # noqa: PLC0415
    from .ws_client import KisWsClient  # noqa: PLC0415
    from .session_gate import ws_capture_window  # noqa: PLC0415

    kis = kis_runtime.ensure_kis_client_for_account(account_id, data_dir)
    if kis is None:  # configured 보장 위반 — 방어적
        raise RuntimeError(f"no KIS client for account {account_id}")

    stream = LiveStream(
        buffer=_buffer,
        writer=LiveWriter(data_dir / "live"),
        date_fn=_today_kst,
    )
    stream.set_active_codes(set(codes))
    ws = KisWsClient(
        approval_key_fn=kis.get_approval_key,
        on_tick=stream.on_tick,
        date_fn=_today_kst,
        gate_fn=lambda: ws_capture_window(_now_ms()),
    )
    stream.ws = ws
    return _StreamConn(
        account_id=account_id,
        stream_obj=stream,
        ws_task=asyncio.create_task(ws.run(codes), name=f"live-ws-{account_id}"),
        flush_task=asyncio.create_task(stream.run_flush_loop(), name=f"live-flush-{account_id}"),
        codes=tuple(codes),
    )


async def _teardown_conn(conn: _StreamConn) -> None:
    """conn의 ws/flush task만 cancel+await. ★ R1: KisClient는 닫지 않는다
    (account 싱글톤은 kis_runtime dict에 남아 다음 _build_conn이 재사용)."""
    for task in (conn.ws_task, conn.flush_task):
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                # M4: 외부에서 우리가 취소된 경우만 전파, 자식 취소는 흡수.
                cur = asyncio.current_task()
                if cur is not None and cur.cancelling():
                    raise
            except Exception:  # noqa: BLE001
                pass


def _market_clock_closed_for_capture(now_ms: int) -> bool:
    """캡처 게이트(ws_capture_window)의 순수-시계 근사 — 주말 또는 정규장
    (09:00–15:30 KST) 밖이면 True. get_status는 sync 라우트라 캘린더 HTTP
    (is_trading_session_today)를 못 쓴다(0a67a3e가 to_thread로 격리한 그 블록).
    그래서 순수 weekday+clock으로 'closed'를 판정해 밤·주말 pill 거짓-앰버를
    막는다. 평일 공휴일 장중은 'closed'로 안 잡혀 reconnecting 앰버로 보이나
    드물어 수용(quote 게이트와 동일 트레이드오프)."""
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import market_phase  # noqa: PLC0415

    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return True
    return market_phase(now_ms) != "regular"  # regular = 09:00–15:30


def _capture_health(
    *, running: bool, ws: object | None, now_ms: int, ref_ms: int,
    stale_after_ms: int, market_closed: bool,
) -> tuple[bool, str]:
    """캡처 헬스 단일 술어(spec 2026-06-08 §2.2) — watchdog과 get_status가 공유.

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


def degraded_account_ids() -> set[int]:
    """현재 WS 연결이 저하된 account_id 집합 — kis_runtime.kis_for_role의 background
    REST 프리엠티브 폴백 신호(late import로 호출). get_status의 degraded 계산과 동일
    의미론: streams 없거나 전역 장 마감이면 빈 집합(closed는 계좌별 결함이 아님,
    line 357-362의 advisor 버그 회피), 정규장에 conn별 health 체크. 안전 호출.

    get_status가 cap_healthy/reason까지 같은 루프로 계산하는 것과 약간 중복되나,
    #53의 get_status(공유 코드)를 건드리지 않으려는 의도적 선택(루프 ~6줄)."""
    from datetime import datetime  # noqa: PLC0415
    from .kis_client import KIS_KST  # noqa: PLC0415

    streams = _state.streams
    started = _state.started_at_ms
    now_ms = _now_ms()
    if started is None or not streams or _market_clock_closed_for_capture(now_ms):
        return set()
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    session_open_ms = int(
        kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    ref_ms = max(started, session_open_ms)
    degraded: set[int] = set()
    for account_id, conn in streams.items():
        ws = getattr(conn.stream_obj, "ws", None)
        healthy, _reason = _capture_health(
            running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
            stale_after_ms=_WATCHDOG_STALE_AFTER_MS, market_closed=False,
        )
        if not healthy:
            degraded.add(account_id)
    return degraded


def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call. dynamic-N 집계(스펙 §5.7)."""
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415

    streams = _state.streams
    poller = _state.rest_poller
    now_ms = _now_ms()
    started = _state.started_at_ms

    running = any(not c.ws_task.done() for c in streams.values()) or (
        poller is not None and poller.alive
    )
    ws_connected = bool(streams) and all(
        getattr(getattr(c.stream_obj, "ws", None), "connected", False)
        for c in streams.values()
    )
    last_tick_ms: int | None = None
    ticks = [
        t for c in streams.values()
        if (t := getattr(getattr(c.stream_obj, "ws", None), "last_tick_ms", None)) is not None
    ]
    if ticks:
        last_tick_ms = max(ticks)

    # 캡처 헬스 — 존재 conn 기준 AND(Q11). conn 0(C4 poller-only)이면 idle.
    if started is None or not streams:
        cap_healthy = bool(running)        # poller-only면 서비스 중 → healthy/idle
        cap_reason = "idle" if running else "offline"
        degraded: list[int] = []
    else:
        kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
        session_open_ms = int(
            kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
        )
        ref_ms = max(started, session_open_ms)
        # market_closed는 전역 상태(계좌별 결함 아님) → per-conn 루프 밖에서 단락.
        # ★ advisor 버그: _capture_health는 market_closed면 소켓을 보기 전에
        # (False,"closed")를 반환 → 루프 안에서 쓰면 밤/주말마다 모든 conn이
        # degraded로 잡혀 degraded_accounts=[0,1] 거짓 신호(Q10 목적과 정반대).
        if _market_clock_closed_for_capture(now_ms):
            cap_healthy, cap_reason, degraded = False, "closed", []
        else:
            cap_healthy, cap_reason, degraded = True, "healthy", []
            for account_id, conn in streams.items():
                ws = getattr(conn.stream_obj, "ws", None)
                healthy, reason = _capture_health(
                    running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
                    stale_after_ms=_WATCHDOG_STALE_AFTER_MS, market_closed=False,
                )
                if not healthy:
                    cap_healthy = False
                    cap_reason = reason     # worst(마지막 비정상). 값 불변(Q10).
                    degraded.append(account_id)
            degraded.sort()

    return LiveStatus(
        running=running,
        started_at_ms=started,
        last_tick_ms=last_tick_ms,
        cycle_lag_ms=0,
        watchlist_count=len(_state.watchlist_codes),
        kis_calls_today=0,
        kis_rate_limit_remaining=None,
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=ws_connected,
        live_set=list(_state.live_set),
        degraded_accounts=degraded,
        capture_healthy=cap_healthy,
        capture_reason=cap_reason,
    )


def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state, _buffer  # noqa: PLW0603
    for conn in list(_state.streams.values()):
        for task in (conn.ws_task, conn.flush_task):
            if task is not None and not task.done():
                task.cancel()
    _state = _State()
    _buffer = LiveBuffer()
    kis_runtime.reset_for_tests()
    _today_promote_last_ms.clear()


# ── Today Promoter ─────────────────────────────────────────────────────────────

async def start_today_promoter(
    *,
    data_dir: Path,
    get_active_codes: Callable[[], list[str]],
    interval_s: float = 300.0,
) -> asyncio.Task:
    """Start the ADR-0043 Today Promotion loop.

    Polls `get_active_codes()` each `interval_s` seconds and calls
    `promote_today(data_dir, code=...)` for each. Per-code exceptions
    are caught and logged so one bad code doesn't break the cycle.
    The outer try/except prevents the loop itself from dying on a
    transient get_active_codes failure.

    Returns the created asyncio.Task; caller (lifespan) is responsible
    for cancelling on shutdown via `stop_today_promoter`.
    """
    log = logging.getLogger(__name__)

    async def loop() -> None:
        while True:
            try:
                codes = get_active_codes()
                for code in codes:
                    try:
                        await promote_today(data_dir, code=code)
                    except Exception:
                        log.exception(
                            "live.today_promote.code_failed code=%s", code,
                        )
            except Exception:
                log.exception("live.today_promote.cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="today-promoter")


async def stop_today_promoter(task: asyncio.Task | None) -> None:
    """Cancel the Today Promoter task and await its completion."""
    if task is None or task.done():
        return
    task.cancel()
    try:  # noqa: SIM105 — 파일 전체가 명시적 try/except 패턴(스타일 통일)
        await task
    except asyncio.CancelledError:
        pass


_WATCHDOG_CHECK_INTERVAL_S = 30.0
_WATCHDOG_STALE_AFTER_MS = 120_000  # ~2 min (≈6 cycles) without a completed tick


async def start_live_stream(*, data_dir: Path) -> bool:
    """start_live_poller의 WS 대체 — 구조 동일(creds/watchlist 가드 → 기동).

    poller와 같은 가드: KIS creds 없거나 watchlist 비면 False.
    symbol-master 필터를 먼저 적용한 뒤 _compute_live_set으로 상위 13 절단.
    ⚠️ 머지(v0.6.1.0) 후: load_document로 폴더 포함 문서를 받아
    display_ordered_codes → symbol-master filter → [:13] 순서를 지킨다.
    KisClient 싱글턴 접근은 `hoga.live.kis_runtime`에서 수행.
    """
    async with _lifecycle_lock:
        return await _start_live_stream_locked(data_dir=data_dir)


def _ensure_poller(data_dir: Path) -> "LiveRestPoller | None":
    """rest_poller를 1회 생성·재사용(§3 분리). creds(account 0) 없으면 None.
    이미 있으면 그대로 반환 → _subscribed(보는종목) 보존(잠복 버그 수정)."""
    from .rest_poller import LiveRestPoller  # noqa: PLC0415

    if _state.rest_poller is not None:
        return _state.rest_poller
    # account 0 creds 게이트: 없으면 폴러 미생성(완전 오프라인). 있으면 account 0
    # client를 미리 확보(부팅 비용·재사용)하되, 폴러엔 *고정* client가 아니라 background
    # resolver를 준다(계정 분리 2026-06-09): 매 사이클 kis_for_role('background')로 account
    # 1(유휴 REST 버킷)을 동적 선택, 저하 시 account 0 폴백. 폴러는 1회 생성·재사용이라
    # resolver 클로저가 라우팅을 시점-평가하므로 재시작/저하 전환에 별도 동기화 불필요.
    if kis_runtime.ensure_kis_client_from_env(data_dir) is None:  # account 0
        return None
    poller = LiveRestPoller(
        lambda: kis_runtime.kis_for_role("background", data_dir), _buffer
    )
    poller.start()
    return poller


def _sync_exclusion(poller: "LiveRestPoller | None", live_set: tuple[str, ...]) -> None:
    """배타 동기화: WS 수집 종목(live_set)을 poller 배제로(ADR-0067 §5).
    exclude-then-subscribe 순서를 위해 conn build/update 전에 호출(스펙 §5.5)."""
    if poller is not None:
        poller.set_excluded_codes(set(live_set))


async def _start_live_stream_locked(*, data_dir: Path) -> bool:
    """start의 본체(락 보유 중). dynamic-N + poller 분리 + C4 (스펙 §5.4)."""
    # 1. account 0 creds 게이트(완전 오프라인이면 stop만)
    n_configured = len(kis_runtime.configured_account_ids(data_dir))
    if n_configured == 0:
        return False

    # 2. 기존 conn 정지(poller는 보존)
    await _stop_streams_locked()

    # 3. poller 보장(없으면 생성, 있으면 _subscribed 보존)
    poller = _ensure_poller(data_dir)
    if poller is None:
        return False  # account 0 creds 사라짐(레이스) — 오프라인

    # 4. Live Set 산출(동적 절단)
    codes = _compute_live_set(data_dir, n_configured)
    parts = partition_live_set(codes, n_configured)

    # 5. exclude-then-subscribe: 먼저 배제 동기화, 그 다음 conn build
    live_set = tuple(codes)
    _sync_exclusion(poller, live_set)

    # 6. 코드 있는 파티션만 conn 생성(dynamic-N; 빈 part = 연결 없음 → C4)
    streams: dict[int, _StreamConn] = {}
    for account_id, part in enumerate(parts):
        if part:
            streams[account_id] = _build_conn(account_id, part, data_dir)

    global _state  # noqa: PLW0603
    _state = _State(
        started_at_ms=_now_ms(),
        n_configured=n_configured,
        watchlist_codes=live_set,
        streams=streams,
        live_set=live_set,
        rest_poller=poller,
    )
    return True


async def _stop_streams_locked() -> None:
    """현재 conn들만 teardown(poller·_state.rest_poller는 보존)."""
    for conn in list(_state.streams.values()):
        await _teardown_conn(conn)
    _state.streams.clear()


async def _stop_live_stream_locked() -> None:
    """완전 정지 — conn teardown + poller stop + _state 리셋."""
    global _state  # noqa: PLW0603
    poller = _state.rest_poller
    await _stop_streams_locked()
    if poller is not None:
        await poller.stop()
    _state = _State()


async def stop_live_stream() -> None:
    """stop_live_poller와 동일 패턴 — KisClient 싱글턴은 건드리지 않는다."""
    async with _lifecycle_lock:
        await _stop_live_stream_locked()


# ── ADR-0067: 보는종목 view 진입점 ─────────────────────────────────────────────

def on_view_subscribe(code: str) -> None:
    """보는종목 구독 신호 — rest_poller.on_subscribe(code)로 위임.

    ws.py(Task B5)가 호출하는 진입점. rest_poller가 없으면(오프라인/start 전)
    예외 없이 no-op — get_active_codes()의 동일 snapshot 패턴 사용.
    """
    poller = _state.rest_poller
    if poller is not None:
        poller.on_subscribe(code)


def on_view_unsubscribe(code: str) -> None:
    """보는종목 구독 해제 신호 — rest_poller.on_unsubscribe(code)로 위임.

    ws.py(Task B5)가 호출하는 진입점. rest_poller가 없으면(오프라인/start 전)
    예외 없이 no-op.
    """
    poller = _state.rest_poller
    if poller is not None:
        poller.on_unsubscribe(code)


async def refresh_live_stream(*, data_dir: Path) -> None:
    """watchlist 변경 후크 — dynamic-N create/teardown (스펙 §5.5).

    streams=={}면(부팅·C4 poller-only) start로 위임. 아니면 account별로:
    part 차면 build, 비면 teardown, 둘 다 있으면 update_codes diff.
    """
    global _state  # noqa: PLW0603

    async with _lifecycle_lock:
        if not _state.streams and _state.rest_poller is None:
            # 한 번도 시작 안 됨 → start가 가드(creds/빈 watchlist) 수행
            await _start_live_stream_locked(data_dir=data_dir)
            return
        if not _state.streams:
            # C4 poller-only 상태에서 watchlist 채워짐 → start로 conn 생성
            await _start_live_stream_locked(data_dir=data_dir)
            return

        n = _state.n_configured
        codes = _compute_live_set(data_dir, n)
        parts = partition_live_set(codes, n)
        live_set = tuple(codes)

        # exclude-then-subscribe: build/update 전에 배제 동기화(스펙 §5.5)
        _sync_exclusion(_state.rest_poller, live_set)

        # Pass 0 (동기, await 없음): 기존 conn들의 on_tick 활성집합을 새 파티션으로
        # **원자 스왑**. cross-boundary 이동(코드가 13-경계를 넘어 conn↔conn 이동)
        # 시, 옛 conn 활성집합에서 빠진 뒤 새 conn에 들어가야 두 writer가 같은
        # {date}/{code}.jsonl에 동시 append하는 이중-write 창이 안 생긴다.
        # set_active_codes는 동기라 이 루프 중엔 틱이 처리되지 않아 스왑이 원자적.
        # (Pass 1의 async WS 재구독에서 코드가 잠시 양쪽 WS에 구독돼도 on_tick 활성
        #  필터가 이미 정확하므로 write는 한 conn으로만 간다 — WS 이중구독 무해.)
        for account_id, part in enumerate(parts):
            conn = _state.streams.get(account_id)
            if conn is not None:
                conn.stream_obj.set_active_codes(set(part))   # type: ignore[union-attr]

        # Pass 1 (async): WS 구독 diff + build/teardown.
        for account_id, part in enumerate(parts):
            conn = _state.streams.get(account_id)
            if part and conn is not None:
                await conn.stream_obj.ws.update_codes(part)      # type: ignore[union-attr]
                _state.streams[account_id] = _StreamConn(
                    account_id=account_id, stream_obj=conn.stream_obj,
                    ws_task=conn.ws_task, flush_task=conn.flush_task,
                    codes=tuple(part),
                )
            elif part and conn is None:
                _state.streams[account_id] = _build_conn(account_id, part, data_dir)
            elif not part and conn is not None:
                await _teardown_conn(conn)
                _state.streams.pop(account_id, None)

        await _buffer.drop_codes_except(set(codes))  # 떠난 코드 ring 해제
        _state = replace(_state, live_set=live_set, watchlist_codes=live_set)


# ADR-0064 이식 — WS 스트림 watchdog
async def _restart_conn(account_id: int, *, data_dir: Path) -> None:
    """죽은 conn 하나만 격리 복구(스펙 §5.6, Q6). lock 안 재검증 → teardown+build.
    R1: KisClient는 보존. 현재 파티션으로 재계산해 그 사이 watchlist 변화 흡수."""
    async with _lifecycle_lock:
        conn = _state.streams.get(account_id)
        if conn is None:
            return
        n = _state.n_configured
        parts = partition_live_set(_compute_live_set(data_dir, n), n)
        codes = parts[account_id] if account_id < len(parts) else []
        await _teardown_conn(conn)
        if codes:
            _state.streams[account_id] = _build_conn(account_id, codes, data_dir)
        else:
            _state.streams.pop(account_id, None)   # 그 사이 watchlist 축소됨


async def _ws_watchdog_check(
    *, data_dir: Path, now_ms: int, stale_after_ms: int
) -> bool:
    """One WS watchdog pass — 연결별 격리 복구(결정 C, Q6). Returns True iff
    어떤 conn이라도 재시작했으면.

    dict 원자 순회(advisor): streams 순회 중 await 금지 — 단일 이벤트루프
    (ADR-0038)라 await-free 순회만 원자적. dead/stale 대상을 동기 수집한 뒤
    변이는 _restart_conn(lock 안)에서.
    """
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import ws_capture_window  # noqa: PLC0415

    if not await asyncio.to_thread(ws_capture_window, now_ms):
        return False
    started = _state.started_at_ms
    if started is None:
        return False

    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    session_open_ms = int(
        kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    ref_ms = max(started, session_open_ms)

    # 동기 수집(await 없음): 재시작 대상 account_id 목록
    to_restart: list[int] = []
    for account_id, conn in _state.streams.items():
        dead = conn.ws_task.done() or conn.flush_task.done()
        ws = getattr(conn.stream_obj, "ws", None)
        _healthy, reason = _capture_health(
            running=True, ws=ws, now_ms=now_ms, ref_ms=ref_ms,
            stale_after_ms=stale_after_ms, market_closed=False,
        )
        if dead or reason == "stale":
            _log.warning("live.stream.watchdog_restart acct=%d dead=%s reason=%s",
                         account_id, dead, reason)
            to_restart.append(account_id)
        elif reason == "sub_failed":
            _log.warning("live.stream.sub_failed acct=%d acked=%s expected=%s — 재시작 안 함",
                         account_id, getattr(ws, "sub_acked", 0),
                         getattr(ws, "sub_expected", 0))

    for account_id in to_restart:
        await _restart_conn(account_id, data_dir=data_dir)
    return bool(to_restart)


async def start_live_stream_watchdog(
    *,
    data_dir: Path,
    check_interval_s: float = _WATCHDOG_CHECK_INTERVAL_S,
    stale_after_ms: int = _WATCHDOG_STALE_AFTER_MS,
) -> asyncio.Task:
    """Spawn the WS stream watchdog loop. Caller (lifespan) cancels on shutdown.
    The loop is self-supervised — a bad pass logs and continues."""

    async def loop() -> None:
        while True:
            try:
                await _ws_watchdog_check(
                    data_dir=data_dir,
                    now_ms=_now_ms(),
                    stale_after_ms=stale_after_ms,
                )
            except Exception:  # noqa: BLE001 — watchdog must outlive any single pass
                _log.exception("live.stream.watchdog_cycle_failed")
            await asyncio.sleep(check_interval_s)

    return asyncio.create_task(loop(), name="live-stream-watchdog")
