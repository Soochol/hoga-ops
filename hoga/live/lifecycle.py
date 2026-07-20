"""Live Capture lifecycle singleton.

실시간 호가·체결·거래원·프로그램매매 수집은 **키움 WS 전담**이다(ADR-0118 —
KIS WS 계층은 PR-G, 거래원 REST 폴러는 PR-F2, 프로그램 REST 는 PR-F4 에서 삭제).
lifecycle은 키움 세션(storage_runtime 소유)·프로그램매매 사이드카(0w latch drain)·
Today Promotion을 오케스트레이션하고, API 계층에 안정적인 `get_status()`를 노출한다.

Lifecycle: ``start_live_stream`` / ``stop_live_stream`` / ``refresh_live_stream``.

``get_status()`` is always safe to call and returns defaults before anything
starts so ``/api/live/status`` works at any time. status 필드는 키움 세션
(``kiwoom_session.status()``)에서 유도한다.

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

from pydantic import BaseModel, Field

from . import kis_runtime
from .buffer import LiveBuffer
from .promote import promote_kiwoom_today
from .settings import load_live_settings
from .signal_alert_monitor import SignalAlertMonitor
from .storage_runtime import StorageRuntimeSnapshot, stop_storage_runtime, sync_storage_runtime

_log = logging.getLogger(__name__)


# ── Wire model ─────────────────────────────────────────────────────────────────

class LiveStatus(BaseModel):
    """Wire model for GET /api/live/status (spec §6)."""

    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    # "수집이 활성인 종목 수" = len(live_set) = 키움 세션 subscribed_count.
    # 프론트는 의도적으로 이 필드를 비소비(useLiveBannerState.ts 주석 참조).
    watchlist_count: int
    # poller-era 필드(wire 호환 유지): 캡처 경로가 REST를 쓰지 않으므로 0/None 고정.
    kis_calls_today: int
    kis_rate_limit_remaining: int | None
    # ADR-0043 / design-review B2 — last successful Today Promotion per code (epoch ms).
    today_promote_last_ms: dict[str, int] = Field(default_factory=dict)
    # WS transport info (unknown keys are safely ignored by frontend)
    transport: str = "ws"
    ws_connected: bool = False
    live_set: list[str] = Field(default_factory=list)
    # 저하 계좌 id 목록(additive; 키움 킥된 계좌).
    degraded_accounts: list[int] = Field(default_factory=list)
    # 캡처 헬스(spec 2026-06-08 §2.2) — cycle_lag_ms를 대체하는 정직한 신호.
    capture_healthy: bool = True
    capture_reason: str = "offline"
    # 구독 유실로 실시간 미수집 중인 종목(additive; 키움 표적 재구독이 처리 → 항상 []).
    capture_missing_codes: list[str] = Field(default_factory=list)
    # broker_poll_* 필드는 제거됨 — 거래원이 키움 0F push 로 전환(PR-F2, ADR-0111 폐지).
    # 프론트 미소비(관측 전용)였음을 확인하고 additive 원칙대로 조용히 내렸다.
    kis_capacity_scheduler: dict[str, object] | None = None
    # Per-cache hit/miss/eviction observability (PR-1). Assembled in the status route.
    cache_stats: dict[str, object] | None = None
    kis_rest_bypass_enabled: bool = False
    # 감독 태스크 헬스(ADR-0088) — 각 lifespan-소유 배경 태스크의 alive 여부.
    supervised_tasks: list[dict[str, object]] = Field(default_factory=list)
    # 키움 WS 수집 관측(ADR-0116, PR-4). 키움 미배선/무자격이면 None. additive.
    # 키(enabled/accounts_configured/connected_accounts/subscribed_count/last_tick_ms/
    # accounts 등)는 KiwoomSessionManager.status()가 정의.
    kiwoom: dict[str, object] | None = None


# ── State ──────────────────────────────────────────────────────────────────────

class _State:
    """In-process live state. Mutated only via this module.

    실시간 캡처는 키움 세션(storage_runtime 소유)이 담당하므로 KIS WS conn 상태
    (streams·live_set)는 없다. lifecycle은 프로그램 REST 사이드카와 키움 세션의
    핸들만 소유한다. 거래원 REST 폴러(ADR-0111)는 키움 0F push 전환으로 삭제(PR-F2)."""

    def __init__(
        self,
        *,
        started_at_ms: int | None = None,
        program_trade_collector=None,
        kiwoom_session=None,
        kis_rest_bypass_enabled: bool = False,
    ) -> None:
        self.started_at_ms = started_at_ms
        self.program_trade_collector = program_trade_collector
        # 키움 WS 세션 매니저(ADR-0116) — storage_runtime이 소유·정합화. 실시간 캡처 SSOT.
        self.kiwoom_session = kiwoom_session
        self.kis_rest_bypass_enabled = kis_rest_bypass_enabled


_state = _State()
_buffer = LiveBuffer()
_signal_alert_monitor: SignalAlertMonitor | None = None

# start/stop/refresh의 await 경계에서 _state 교체가 interleave 되지 않도록 직렬화.
# start가 내부에서 stop을 부르므로(재진입) 잠금 없는 `_stop_live_stream_locked`를
# 공유한다 — 공개 stop만 락을 잡는다.
_lifecycle_lock = asyncio.Lock()

# ADR-0043 / design-review B2 — in-memory dict of code → last successful
# Today Promotion epoch_ms. Surfaced via LiveStatus.
_today_promote_last_ms: dict[str, int] = {}


def record_today_promote_success(code: str, t_ms: int) -> None:
    """Called by promote_today on success; surfaced via LiveStatus (ADR-0043)."""
    _today_promote_last_ms[code] = t_ms


def get_today_promote_last_ms() -> dict[str, int]:
    """Snapshot of last successful Today Promotion epoch_ms per code."""
    return dict(_today_promote_last_ms)


def get_kiwoom_capture_codes() -> list[str]:
    """키움 WS 수집 중인 종목(ADR-0116) — 승격 루프(promote_kiwoom_today)가 읽는다.

    kiwoom_session이 None(off/미배선)이면 []. 호출 시점 스냅샷 계약.
    storage_runtime.sync가 매 사이클 kiwoom_session.sync로 갱신한다."""
    session = _state.kiwoom_session
    if session is None:
        return []
    return session.active_codes()


def get_buffer() -> LiveBuffer:
    return _buffer


def configure_signal_alert_monitor(
    data_dir: Path, publish: Callable[[dict], None],
) -> None:
    global _signal_alert_monitor  # noqa: PLW0603 - process singleton owned by lifecycle
    _signal_alert_monitor = SignalAlertMonitor(data_dir, publish=publish)


def get_signal_alert_monitor() -> SignalAlertMonitor | None:
    return _signal_alert_monitor


def get_today_ask_peak(code: str) -> dict | None:
    """Return today's ask-peak snapshot for a captured code (키움 스트림).

    실시간 캡처=키움 전담(ADR-0118 PR-G)이므로 키움 세션의 살아있는 스트림(코드-disjoint
    파티션)에서 조회한다. 소유 스트림 1개만 non-None을 반환한다."""
    session = _state.kiwoom_session
    if session is None:
        return None
    for stream in session.broker_dispatch_streams():
        snapshot = getattr(stream, "ask_peak_snapshot", None)
        if snapshot is None:
            continue
        result = snapshot(code)
        if result is not None:
            return result
    return None


def get_today_bid_peak(code: str) -> dict | None:
    """Return today's bid-peak snapshot for a captured code (키움 스트림)."""
    session = _state.kiwoom_session
    if session is None:
        return None
    for stream in session.broker_dispatch_streams():
        snapshot = getattr(stream, "bid_peak_snapshot", None)
        if snapshot is None:
            continue
        result = snapshot(code)
        if result is not None:
            return result
    return None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _today_kst() -> str:
    from datetime import datetime, timedelta, timezone  # noqa: PLC0415

    return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")


def _market_clock_closed_for_capture(now_ms: int) -> bool:
    """캡처 게이트(ws_capture_window)의 순수-시계 근사 — 주말 또는 정규장
    (09:00–15:30 KST) 밖이면 True. get_status는 sync 라우트라 캘린더 HTTP
    (is_trading_session_today)를 못 쓴다. 그래서 순수 weekday+clock으로 'closed'를
    판정해 밤·주말 pill 거짓-앰버를 막는다. 평일 공휴일 장중은 'closed'로 안 잡혀
    reconnecting 앰버로 보이나 드물어 수용(quote 게이트와 동일 트레이드오프)."""
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import market_phase  # noqa: PLC0415

    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    if kst.weekday() >= 5:  # noqa: PLR2004 — 토/일
        return True
    return market_phase(now_ms) != "regular"  # regular = 09:00–15:30


def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call.

    status 필드는 키움 세션(``kiwoom_session.status()``)에서 유도한다(ADR-0118 PR-G).
    kiwoom off/미배선이면 offline. kis_rest_bypass만 lifecycle 소유."""
    now_ms = _now_ms()
    k = _state.kiwoom_session.status() if _state.kiwoom_session is not None else None

    running = bool(k and (k["connected_accounts"] > 0 or k["subscribed_count"] > 0))
    ws_connected = bool(k and k["connected_accounts"] > 0)
    live_set = list(k["subscribed_codes"]) if k else []
    last_tick_ms = k["last_tick_ms"] if k else None
    degraded_accounts = (
        [a["account_id"] for a in k["accounts"] if a["kicked_by_peer"]] if k else []
    )

    if k is None or k["connected_accounts"] == 0:
        cap_healthy = False
        cap_reason = "closed" if _market_clock_closed_for_capture(now_ms) else "offline"
    elif k.get("warmup_incomplete"):
        cap_healthy = False
        cap_reason = "warmup_incomplete"
    else:
        cap_healthy = True
        cap_reason = "healthy"

    return LiveStatus(
        running=running,
        started_at_ms=_state.started_at_ms,
        last_tick_ms=last_tick_ms,
        cycle_lag_ms=0,
        watchlist_count=len(live_set),
        kis_calls_today=0,
        kis_rate_limit_remaining=None,
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=ws_connected,
        live_set=live_set,
        degraded_accounts=degraded_accounts,
        capture_healthy=cap_healthy,
        capture_reason=cap_reason,
        capture_missing_codes=[],
        kis_rest_bypass_enabled=_state.kis_rest_bypass_enabled,
        kiwoom=k,
    )


def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state, _buffer  # noqa: PLW0603
    collector = _state.program_trade_collector
    task = getattr(collector, "_task", None)
    if task is not None and not task.done():
        task.cancel()
    _state = _State()
    _buffer = LiveBuffer()
    kis_runtime.reset_for_tests()
    _today_promote_last_ms.clear()


def refresh_status_from_settings(data_dir: Path) -> None:
    settings = load_live_settings(data_dir)
    _state.kis_rest_bypass_enabled = settings.kis_rest_bypass_enabled


# ── Today Promoter ─────────────────────────────────────────────────────────────

async def start_today_promoter(
    *,
    data_dir: Path,
    get_kiwoom_capture_codes: Callable[[], list[str]] | None = None,
    interval_s: float = 300.0,
    on_promoted: Callable[[dict], object] | None = None,
) -> asyncio.Task:
    """Start the ADR-0043 Today Promotion loop (키움 전담).

    Polls `get_kiwoom_capture_codes()` each `interval_s` seconds and calls
    `promote_kiwoom_today(data_dir, code=...)` for each — live_kiwoom JSONL →
    kiwoom_live parquet(히트맵·관심종목 영속화, ADR-0116). Per-code exceptions
    are caught and logged so one bad code doesn't break the cycle.
    (KIS 팔이었던 get_active_codes/promote_today 는 KIS live/ 수집 소멸로 상시
    no-op 이 되어 제거됨 — 2026-07-20 감사.)

    `on_promoted` (typically `EventBus.publish`, injected in app.py via
    functools.partial) receives a `{type, code, date}` dict after each *real*
    promotion (promote_kiwoom_today returned a date, not None) — 이 발행이
    프론트 today 갱신의 유일한 소스다. skip(None)은 스퓨리어스 리페치를 막는다.

    Returns the created asyncio.Task; caller (lifespan) is responsible
    for cancelling on shutdown via `stop_today_promoter`.
    """
    log = logging.getLogger(__name__)

    def _publish_promotion(code: str, promoted_date: str | None) -> None:
        if promoted_date is not None and on_promoted is not None:
            on_promoted({
                "type": "promotion_completed",
                "code": code,
                "date": promoted_date,
            })

    async def loop() -> None:
        while True:
            try:
                # 미배선/off면 콜백이 [] 반환이라 루프 no-op.
                kiwoom_codes = (
                    get_kiwoom_capture_codes() if get_kiwoom_capture_codes else []
                )
                for code in kiwoom_codes:
                    try:
                        _publish_promotion(
                            code, await promote_kiwoom_today(data_dir, code=code),
                        )
                    except Exception:
                        log.exception(
                            "live.today_promote.kiwoom_code_failed code=%s", code,
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


# ── Start / refresh / stop ──────────────────────────────────────────────────────

async def start_live_stream(*, data_dir: Path) -> bool:
    """Live Capture 기동 — KIS creds 가드 통과 시 키움 세션 정합화.

    KIS 자격증명(account 0)이 없으면 False(오프라인). 실시간 호가·체결·거래원(0F)은
    키움 세션이 담당하고(storage_runtime.sync), 프로그램 REST 사이드카는 KIS 계정을 쓴다."""
    async with _lifecycle_lock:
        return await _start_live_stream_locked(data_dir=data_dir)


def _signal_alert_target_names(data_dir: Path, codes: set[str]) -> dict[str, str]:
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    by_code = {entry.code: entry.name for entry in load_document(data_dir).entries}
    return {code: by_code.get(code, code) for code in codes}


def _storage_set(snapshot: StorageRuntimeSnapshot) -> tuple[str, ...]:
    """저장 중인 전체 코드 = ws_targets ∪ kiwoom_targets(dedup, 순서 보존). 버퍼 링
    보존(drop_codes_except)의 SSOT — 컷오버 후 저장은 kiwoom_targets에만 있다(ws_targets는
    항상 빈 튜플). ws_targets 항은 하위호환용 no-op(항상 ())."""
    return tuple(dict.fromkeys(snapshot.ws_targets + snapshot.kiwoom_targets))


async def _sync_storage_targets(data_dir: Path) -> StorageRuntimeSnapshot:
    snapshot = await sync_storage_runtime(
        data_dir,
        state=_state,
        buffer=_buffer,
        date_fn=_today_kst,
        now_ms_fn=_now_ms,
    )
    monitor = get_signal_alert_monitor()
    if monitor is not None:
        # 저장셋 전체(키움 히트맵 + 관심종목)를 monitor 타깃에. 안 그러면 stream.on_tick의
        # ingest_orderbook이 code∉targets로 전량 드롭돼 매도총잔량 알림이 침묵 정지한다.
        monitor.set_targets(_signal_alert_target_names(data_dir, set(_storage_set(snapshot))))
    return snapshot


async def _start_live_stream_locked(*, data_dir: Path) -> bool:
    """start의 본체(락 보유 중) — 키움 세션 정합화.

    KIS creds(account 0)가 없으면 오프라인(False). 실시간 캡처(호가·체결·거래원 0F)는
    키움 세션이 담당한다(_sync_storage_targets → storage_runtime.sync)."""
    refresh_status_from_settings(data_dir)

    # KIS creds 게이트(account 0). 프로그램 REST 사이드카·캔들 백필의 전제.
    if len(kis_runtime.configured_account_ids(data_dir)) == 0:
        return False

    # Storage targets 산출: 실시간 캡처는 키움 세션이 흡수(storage_runtime.sync).
    snapshot = await _sync_storage_targets(data_dir)
    # 저장셋 밖 표시 링만 해제.
    await _buffer.drop_codes_except(set(_storage_set(snapshot)))
    _state.started_at_ms = _now_ms()
    return True


async def _stop_live_stream_locked() -> None:
    """완전 정지 — 키움 세션/프로그램 사이드카 stop + _state 리셋."""
    global _state  # noqa: PLW0603
    await stop_storage_runtime(_state)
    _state = _State()


async def stop_live_stream() -> None:
    """완전 정지 — KisClient 싱글턴은 건드리지 않는다."""
    async with _lifecycle_lock:
        await _stop_live_stream_locked()


# ── ADR-0067: 보는종목 view 진입점 ─────────────────────────────────────────────

def _resolve_view_venues(venues: set[str] | None) -> set[str]:
    """뷰 구독 venue 해석 — 미지정(구 프론트)이면 현재 창 venue 1개(=현재 실시간)."""
    if venues:
        return venues
    from .session_gate import target_ws_venue  # noqa: PLC0415

    return {target_ws_venue(_now_ms())}


async def on_view_subscribe(
    code: str, venues: set[str] | None = None, *, ref: str | None = None,
) -> bool:
    """보는종목 구독 신호 — 키움 매니저 표시셋에 위임(ADR-0118 PR-C·PR-G). ws.py 진입점.

    키움이 만석(전 연결 슬롯 소진)으로 거부하면 False → ws.py가 요청 탭에 만석 이벤트를
    보낸다. 키움 미배선(오프라인/start 전)이면 True(no-op). venues 미지정(구 프론트)이면
    현재 창 venue 1개로 기본. ref는 연결(탭) 식별 토큰 — 두 탭이 같은 종목을 봐도 참조만
    늘고 등록은 1회(refcount)."""
    session = _state.kiwoom_session
    if session is None:
        return True
    return await session.on_view_subscribe(code, _resolve_view_venues(venues), ref=ref or code)


async def on_view_unsubscribe(
    code: str, venues: set[str] | None = None, *, ref: str | None = None,
) -> None:
    """보는종목 구독 해제 신호 — 키움 매니저 표시셋에 위임(ADR-0118 PR-C·PR-G). 키움은
    참조 0이면 유예 후 해제(즉시 아님). venues·ref는 구독 시와 동일하게 ws.py가 전달."""
    session = _state.kiwoom_session
    if session is None:
        return
    await session.on_view_unsubscribe(code, _resolve_view_venues(venues), ref=ref or code)


async def refresh_live_stream(*, data_dir: Path) -> None:
    """watchlist/히트맵 변경 후크 — 저장 타깃 재계획 + 키움 정합화.

    한 번도 start 안 됐으면(started_at_ms None) start로 위임(creds 가드 수행)."""
    async with _lifecycle_lock:
        refresh_status_from_settings(data_dir)
        if _state.started_at_ms is None:
            # 한 번도 시작 안 됨 → start가 가드(creds) 수행.
            await _start_live_stream_locked(data_dir=data_dir)
            return

        snapshot = await _sync_storage_targets(data_dir)
        # 저장셋(ws∪kiwoom) 밖 링만 해제 — 컷오버 후 ws_targets 빈값이어도 키움 표시 링 보존.
        await _buffer.drop_codes_except(set(_storage_set(snapshot)))


# ── ADR-0118 §5 — 키움 세션 워치독(별개 태스크) ─────────────────────────────────
_KIWOOM_WATCHDOG_INTERVAL_S = 30.0


async def start_kiwoom_session_watchdog(
    *, interval_s: float = _KIWOOM_WATCHDOG_INTERVAL_S,
) -> asyncio.Task:
    """키움 세션 워치독 30s 루프(ADR-0118 §5). 죽은 conn 재빌드·시간대 venue 스왑·
    표적 재구독·08:50 저장셋 등록 완결 술어를 매니저 watchdog_pass에 위임한다.

    _state.kiwoom_session은 storage_runtime.sync가 lazy 생성하므로 매 패스에 조회 —
    미생성(kiwoom off/부팅 전)이면 no-op. 자가 감독(한 패스 실패는 로그 후 계속) —
    lifespan(startup_runtime)이 shutdown에 cancel한다."""

    async def loop() -> None:
        while True:
            try:
                session = _state.kiwoom_session
                if session is not None:
                    await session.watchdog_pass(_now_ms())
            except Exception:  # noqa: BLE001 — 워치독은 어떤 단일 패스보다 오래 살아야 한다
                _log.exception("live.kiwoom.watchdog_cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="kiwoom-session-watchdog")
