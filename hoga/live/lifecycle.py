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
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .rest_poller import LiveRestPoller

from pydantic import BaseModel, Field

from . import account_health, kis_access, kis_runtime  # health probe / role 라우팅 / 리소스
from .buffer import LiveBuffer
from .live_session import (  # noqa: F401 — C3 재export(호출부·테스트 호환) + LiveSession 사용
    _PER_ACCOUNT_MAX,
    KIS_WS_MAX_REGISTRATIONS,
    LIVE_SET_MAX_CODES,
    TRS_PER_CODE,
    LiveSession,
    _capture_health,
    _compute_live_set,
    _StreamConn,
    display_ordered_codes,
    live_set_codes,
    partition_live_set,
)
from .promote import promote_today

_log = logging.getLogger(__name__)


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

class _State:
    """In-process live state. streams + 세션 스코프 상태(started_at_ms·n_configured·
    watchlist_codes·live_set)는 LiveSession이 소유하고, 여기선 위임 property로 노출한다
    (C3 step 2 — 기존 호출부·테스트의 `_state.streams`/`started_at_ms` 등 접근 호환).
    rest_poller는 WS 세션 밖(REST)이라 lifecycle이 직접 소유. Mutated only via this module."""

    def __init__(
        self,
        *,
        started_at_ms: int | None = None,
        n_configured: int = 0,
        watchlist_codes: tuple[str, ...] = (),
        streams: dict[int, _StreamConn] | None = None,
        live_set: tuple[str, ...] = (),
        rest_poller: LiveRestPoller | None = None,
        session: LiveSession | None = None,
    ) -> None:
        if session is None:
            session = LiveSession()
            session.started_at_ms = started_at_ms
            session.n_configured = n_configured
            session.watchlist_codes = tuple(watchlist_codes)
            session.live_set = tuple(live_set)
            if streams is not None:
                session.streams = streams
        self.session = session
        self.rest_poller = rest_poller

    # 위임 property — 기존 `_state.X` 접근 호환(streams dict의 in-place 변이도 그대로 통과).
    @property
    def streams(self) -> dict[int, _StreamConn]:
        return self.session.streams

    @property
    def started_at_ms(self) -> int | None:
        return self.session.started_at_ms

    @property
    def n_configured(self) -> int:
        return self.session.n_configured

    @property
    def watchlist_codes(self) -> tuple[str, ...]:
        return self.session.watchlist_codes

    @property
    def live_set(self) -> tuple[str, ...]:
        return self.session.live_set


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
    # sync ws_capture_window을 의도적으로 씀(아래 gate_fn): KisWsClient가 gate_fn을
    # `await to_thread(gate_fn)`로 감싸 blocking을 격리한다 — 유일한 합법적 sync 사용처.
    from .session_gate import ws_capture_window  # noqa: PLC0415
    from .stream import LiveStream  # noqa: PLC0415
    from .writer import LiveWriter  # noqa: PLC0415
    from .ws_client import KisWsClient  # noqa: PLC0415

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


def _ws_degraded_probe() -> set[int]:
    """account_health가 등록받는 WS-degraded probe(의존 역전 — leaf가 lifecycle을 import
    안 하게). 호출 시점의 `_state.session`에서 평가 — start가 session을 통째 교체해도 항상
    *현재* 세션을 읽는다(bound method `_state.session.degraded_set` 등록이면 죽은 인스턴스를
    잡음, C3 trap). market_closed(전역 장 마감)는 lifecycle이 계산해 전달."""
    now_ms = _now_ms()
    return _state.session.degraded_set(
        now_ms=now_ms,
        market_closed=_market_clock_closed_for_capture(now_ms),
        stale_after_ms=_WATCHDOG_STALE_AFTER_MS,
    )


# 모듈 로드 시 1회 push 등록 — probe는 _state(reset로 비워짐)를 시점-평가하므로 stateless,
# reset_for_tests가 따로 해제할 필요 없음(빈 _state → 빈 집합).
account_health.register_ws_probe(_ws_degraded_probe)


def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call. dynamic-N 집계(스펙 §5.7).

    streams-파생 필드(running의 streams-항·ws_connected·last_tick·cap_healthy/reason/degraded)는
    session.status_fields가 단일 계산(account_health WS-probe와 공유, dedup). poller.alive OR-항·
    idle/offline·today-promote 합성은 여기 전용. market_closed는 lifecycle이 계산해 전달."""
    poller = _state.rest_poller
    now_ms = _now_ms()
    sf = _state.session.status_fields(
        now_ms=now_ms,
        market_closed=_market_clock_closed_for_capture(now_ms),
        stale_after_ms=_WATCHDOG_STALE_AFTER_MS,
    )
    running = sf["streams_running"] or (poller is not None and poller.alive)

    # 캡처 헬스 — 존재 conn 기준(Q11). capture=None(conn 0, C4 poller-only)이면 running과
    # 결합해 idle/offline 판정(streams 있을 때의 셋은 session이 계산).
    capture = sf["capture"]
    if capture is None:
        cap_healthy = bool(running)        # poller-only면 서비스 중 → healthy/idle
        cap_reason = "idle" if running else "offline"
        degraded: list[int] = []
    else:
        cap_healthy, cap_reason, degraded = capture

    return LiveStatus(
        running=running,
        started_at_ms=sf["started_at_ms"],
        last_tick_ms=sf["last_tick_ms"],
        cycle_lag_ms=0,
        watchlist_count=sf["watchlist_count"],
        kis_calls_today=0,
        kis_rate_limit_remaining=None,
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=sf["ws_connected"],
        live_set=sf["live_set"],
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
    symbol-master 필터를 먼저 적용한 뒤 _compute_live_set으로 상위 (_PER_ACCOUNT_MAX×N) 절단.
    ⚠️ 머지(v0.6.1.0) 후: load_document로 폴더 포함 문서를 받아
    display_ordered_codes → symbol-master filter → [:13] 순서를 지킨다.
    KisClient 싱글턴 접근은 `hoga.live.kis_runtime`에서 수행.
    """
    async with _lifecycle_lock:
        return await _start_live_stream_locked(data_dir=data_dir)


def _ensure_poller(data_dir: Path) -> LiveRestPoller | None:
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
        lambda: kis_access.kis_for_role("background", data_dir), _buffer
    )
    poller.start()
    return poller


def _sync_exclusion(poller: LiveRestPoller | None, live_set: tuple[str, ...]) -> None:
    """배타 동기화: WS 수집 종목(live_set)을 poller 배제로(ADR-0067 §5).
    exclude-then-subscribe 순서를 위해 conn build/update 전에 호출(스펙 §5.5)."""
    if poller is not None:
        poller.set_excluded_codes(set(live_set))


async def _start_live_stream_locked(*, data_dir: Path) -> bool:
    """start의 본체(락 보유 중). dynamic-N + poller 분리 + C4 (스펙 §5.4).

    exclude-then-subscribe 순서를 lifecycle이 봉인(C3 ①): stop → ensure_poller →
    _sync_exclusion → session.start(conn build). poller는 WS 세션 밖이라 lifecycle 소유.
    """
    # 1. account 0 creds 게이트(완전 오프라인이면 stop만)
    n_configured = len(kis_runtime.configured_account_ids(data_dir))
    if n_configured == 0:
        return False

    # 2. 기존 conn 정지(poller는 보존)
    await _state.session.stop(_teardown_conn)

    # 3. poller 보장(없으면 생성, 있으면 _subscribed 보존)
    poller = _ensure_poller(data_dir)
    if poller is None:
        return False  # account 0 creds 사라짐(레이스) — 오프라인

    # 4. Live Set 산출(동적 절단)
    codes = _compute_live_set(data_dir, n_configured)

    # 5. exclude-then-subscribe: 먼저 배제 동기화, 그 다음 conn build(session.start)
    _sync_exclusion(poller, tuple(codes))

    # 6. 코드 있는 파티션만 conn 생성(session이 dynamic-N 빌드 — 빈 part=연결 없음 → C4)
    await _state.session.start(
        codes=codes, n_configured=n_configured, data_dir=data_dir,
        now_ms=_now_ms(), build_conn=_build_conn,
    )
    _state.rest_poller = poller
    return True


async def _stop_streams_locked() -> None:
    """현재 conn들만 teardown(poller·_state.rest_poller는 보존) — session에 위임."""
    await _state.session.stop(_teardown_conn)


async def _stop_live_stream_locked() -> None:
    """완전 정지 — conn teardown + poller stop + _state 리셋."""
    global _state  # noqa: PLW0603
    poller = _state.rest_poller
    await _state.session.stop(_teardown_conn)
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
    async with _lifecycle_lock:
        if not _state.streams and _state.rest_poller is None:
            # 한 번도 시작 안 됨 → start가 가드(creds/빈 watchlist) 수행
            await _start_live_stream_locked(data_dir=data_dir)
            return
        if not _state.streams:
            # C4 poller-only 상태에서 watchlist 채워짐 → start로 conn 생성
            await _start_live_stream_locked(data_dir=data_dir)
            return

        codes = _compute_live_set(data_dir, _state.n_configured)

        # exclude-then-subscribe: build/update 전에 배제 동기화(스펙 §5.5, C3 ①).
        _sync_exclusion(_state.rest_poller, tuple(codes))

        # 원자 활성집합 스왑(Pass 0) + WS 재구독 diff·build/teardown(Pass 1) +
        # live_set/watchlist 갱신은 session.refresh가 소유(이중-write 방지 불변식 봉인).
        await _state.session.refresh(
            codes=codes, data_dir=data_dir,
            build_conn=_build_conn, teardown_conn=_teardown_conn,
        )
        await _buffer.drop_codes_except(set(codes))  # 떠난 코드 ring 해제


# ADR-0064 이식 — WS 스트림 watchdog
async def _restart_conn(account_id: int, *, data_dir: Path) -> None:
    """죽은 conn 하나만 격리 복구 — session.restart에 위임(락 보유). teardown+build(R1
    KisClient 보존)·현재 파티션 재계산은 session이 소유(스펙 §5.6, Q6)."""
    async with _lifecycle_lock:
        await _state.session.restart(
            account_id, data_dir=data_dir,
            build_conn=_build_conn, teardown_conn=_teardown_conn,
        )


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
    from .session_gate import ws_capture_window_async  # noqa: PLC0415

    if not await ws_capture_window_async(now_ms):  # async 진입점이 to_thread 봉인(blocking 계약)
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
