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
from typing import Literal

from pydantic import BaseModel, Field

from hoga.live.after_hours_store import (
    StoredAfterHoursBook,
    save_cycle,
    today_kst_yyyymmdd,
)
from hoga.live.session_gate import is_after_hours_single_price_window
from hoga.util.timeenc import KST

from . import kis_runtime
from .buffer import LiveBuffer
from .promote import promote_kiwoom_today
from .settings import load_live_settings
from .signal_alert_monitor import SignalAlertMonitor
from .storage_runtime import StorageRuntimeSnapshot, stop_storage_runtime, sync_storage_runtime

_log = logging.getLogger(__name__)


# ── Wire model ─────────────────────────────────────────────────────────────────

class KiwoomGovernorSnapshot(BaseModel):
    """`kiwoom_capacity.KiwoomCapacityScheduler.snapshot()` 의 wire 모델.

    **오래 `dict[str, object]` 였다.** 그 상태에서도 `/api/live/status` 로 나가긴
    했지만 프론트에는 타입 미러도 소비도 0곳이라, ADR-0136 이 KIS 의
    `kis_calls_today`/`kis_rate_limit_remaining` 을 두고 지적한 *"프론트 렌더 0곳인
    죽은 필드"* 와 같은 상태였다(값이 실데이터라는 점만 달랐다).

    ⚠ **필드를 빠뜨리면 500 이 아니라 조용히 사라진다** — `response_model` 이
    선언되지 않은 키를 스트립하기 때문이다. `snapshot()` 에 키를 더하면 여기도
    더할 것. `tests/unit/live/test_kiwoom_governor_snapshot_wire.py` 가 두 키 집합을
    대조해 그 실수를 막는다.
    """

    queued: int
    inflight: int
    workers: int
    tr_buckets: int
    accounts: int
    #: 계정별 **시도** 수(성공 전에 센다) — 쏠림이 없으면 앱키 증설이 배수를 못 낸다.
    calls_by_account: dict[int, int] = Field(default_factory=dict)
    #: 계정별 인증 실패 **누계**. 리셋되지 않으므로 "지금 죽었나" 의 답이 아니다.
    auth_failures_by_account: dict[int, int] = Field(default_factory=dict)
    #: 지금 격리 창(60s) 안에 있는 계정. **정상 만료도 여기 들어온다** — 배너 근거로
    #: 쓰지 말 것.
    auth_blocked_accounts: list[int] = Field(default_factory=list)
    #: 연속 실패가 임계를 넘어 **앱키가 죽었다고 판정된** 계정.
    auth_failing_accounts: list[int] = Field(default_factory=list)
    #: 위 계정에 대응하는 **env 변수명**(`auth_failing_accounts` 와 같은 순서).
    #: 화면은 이쪽을 보여 준다 — account 5 ↔ `KIWOOM_APP_KEY_6` 의 off-by-one 을
    #: 소비자가 다시 계산하면 애먼 키를 지우게 된다.
    auth_failing_env_keys: list[str] = Field(default_factory=list)
    background_deferred_due_to_user_visible: int = 0


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
    # ADR-0043 / design-review B2 — last successful Today Promotion per code (epoch ms).
    today_promote_last_ms: dict[str, int] = Field(default_factory=dict)
    # WS transport info (unknown keys are safely ignored by frontend)
    transport: str = "ws"
    ws_connected: bool = False
    live_set: list[str] = Field(default_factory=list)
    # 저하 계좌 id 목록(additive; 키움 킥된 계좌).
    degraded_accounts: list[int] = Field(default_factory=list)
    # 캡처 헬스(spec 2026-06-08 §2.2) — cycle_lag_ms를 대체하는 정직한 신호.
    #
    # `capture_reason` 은 **Literal 로 닫아 둔다**. 프론트
    # (`frontend/src/api/liveStatus.ts::CaptureReason`)가 같은 4값을 미러하고 라벨·
    # 등급 표를 exhaustive 로 묶어 놓았기 때문에, 여기에 값을 늘리면 저쪽도 같이
    # 늘려야 한다. str 이던 시절엔 그 요구가 아무 데서도 발생하지 않아서 표가 조용히
    # 갈렸다 — 죽은 reason 4개가 프론트에 남고 실제 값 하나는 매핑이 없었다.
    capture_healthy: bool = True
    capture_reason: Literal["healthy", "offline", "closed", "registration_incomplete"] = "offline"
    # 구독 유실로 실시간 미수집 중인 종목(additive; 키움 표적 재구독이 처리 → 항상 []).
    capture_missing_codes: list[str] = Field(default_factory=list)
    # broker_poll_* 필드는 제거됨 — 거래원이 키움 0F push 로 전환(PR-F2, ADR-0111 폐지).
    # 프론트 미소비(관측 전용)였음을 확인하고 additive 원칙대로 조용히 내렸다.
    #: 키움 REST 유량 거버너 관측 표면. 거버너 미가동이면 None.
    rest_capacity_scheduler: KiwoomGovernorSnapshot | None = None
    # Per-cache hit/miss/eviction observability (PR-1). Assembled in the status route.
    cache_stats: dict[str, object] | None = None
    rest_bypass_enabled: bool = False
    # 감독 태스크 헬스(ADR-0088) — 각 lifespan-소유 배경 태스크의 alive 여부.
    supervised_tasks: list[dict[str, object]] = Field(default_factory=list)
    # 디스크 여유(free_pct·free_gib·low). 조회 실패·데이터 디렉터리 미주입이면 None.
    #
    # 왜 여기 싣는가: 디스크 잠식의 능동 신호가 하루 한 번 17:00 로그 한 줄뿐이라
    # 아무도 읽지 않았다. deep health 에도 실리지만 그건 워치독이 묻는 자리이고,
    # 워치독은 디스크로 재시작하지 않는다(재시작이 디스크를 못 비운다). 사람이
    # 보는 표면이 필요해서 이미 5초마다 폴링되는 이 응답에 얹었다 — 부품 추가 0.
    disk: dict[str, object] | None = None
    # 키움 WS 수집 관측(ADR-0116, PR-4). 키움 미배선/무자격이면 None. additive.
    # 키(enabled/accounts_configured/connected_accounts/subscribed_count/last_tick_ms/
    # accounts 등)는 KiwoomSessionManager.status()가 정의.
    kiwoom: dict[str, object] | None = None
    # 공유 data_dir writer 의 소유권(ADR-0094 확장, 2026-08-10).
    # `{writer: {"owned": bool|None, "reason": str|None}}` — 키는 `ownership._ACQUIRERS`.
    #
    # **화면만 봐서는 알 수 없는 강등**이라 여기 싣는다: 락을 못 잡은 인스턴스는
    # 그 일을 안 하지만 읽기 경로는 승자가 쓴 파일을 그대로 서빙하므로 정상과
    # 구별되지 않는다. `owned=false` 가 유일한 신호다.
    # `owned=null` = 아직 시도 안 함(소유권 없음이 아니다).
    writers: dict[str, object] | None = None


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
        rest_bypass_enabled: bool = False,
    ) -> None:
        self.started_at_ms = started_at_ms
        self.program_trade_collector = program_trade_collector
        # 키움 WS 세션 매니저(ADR-0116) — storage_runtime이 소유·정합화. 실시간 캡처 SSOT.
        self.kiwoom_session = kiwoom_session
        self.rest_bypass_enabled = rest_bypass_enabled


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
    """Called by promote_kiwoom_today on success; surfaced via LiveStatus (ADR-0043)."""
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


def get_program_trade_task() -> asyncio.Task | None:
    """프로그램매매 수집기의 실행 태스크 — ADR-0088 liveness 노출용(supervised_tasks).

    라이브가 꺼져 있거나 수집기가 아직 안 만들어졌으면 None. 이 접근자가 없던 동안
    `ProgramTradeCollectorStatus.running` 이 유일한 신호였고, 그 플래그는 start()에서
    True 로 찍힌 뒤 갱신되지 않아 **태스크가 죽어도 계속 True** 였다 — ADR-0064 가
    제거한 바로 그 거짓 health 패턴이다.
    """
    collector = _state.program_trade_collector
    if collector is None:
        return None
    return getattr(collector, "task", None)


def get_vi_status(code: str) -> dict | None:
    """종목의 최신 VI 이벤트 상태(키움 1h, 계정 0 수신) — /api/live/vi-status 소스.

    kiwoom_session이 None(off/미배선)이면 None — 프론트는 예상가 계산만 표시."""
    session = _state.kiwoom_session
    if session is None:
        return None
    return session.vi_status(code)


def get_buffer() -> LiveBuffer:
    return _buffer


def configure_signal_alert_monitor(
    data_dir: Path, publish: Callable[[dict], None],
) -> None:
    global _signal_alert_monitor  # noqa: PLW0603 - process singleton owned by lifecycle
    _signal_alert_monitor = SignalAlertMonitor(data_dir, publish=publish)


def get_signal_alert_monitor() -> SignalAlertMonitor | None:
    return _signal_alert_monitor


def get_today_ask_peak(code: str, venue: str) -> dict | None:
    """Return today's ask-peak snapshot for a captured code (키움 스트림).

    실시간 캡처=키움 전담(ADR-0118 PR-G)이므로 키움 세션의 살아있는 스트림(코드-disjoint
    파티션)에서 조회한다. 소유 스트림 1개만 non-None을 반환한다."""
    session = _state.kiwoom_session
    if session is None:
        return None
    for stream in session.capture_streams():
        snapshot = getattr(stream, "ask_peak_snapshot", None)
        if snapshot is None:
            continue
        result = snapshot(code, venue)
        if result is not None:
            return result
    return None


# 오늘분 최대벽 **지연 시딩** — (code, venue, date) 당 1회.
#
# 왜 지연인가: 하루치 JSONL 은 venue 당 ~1GB(300종목 × 3 venue), 종목·venue 하나를 재생하는
# 데 실측 ~144ms 다(2026-08-21, 005930 KRX / 8.6k행 / 3.9MB). 기동 시 전량 시딩은 ~130초와
# ~3.2GB 파싱을 뜻하므로 성립하지 않는다. 사용자가 실제로 여는 종목은 소수라, 그 요청이
# 올 때 그 (code, venue) 하나만 재생한다.
_today_peak_seed_locks: dict[tuple[str, str, str], asyncio.Lock] = {}
_today_peak_seeded: set[tuple[str, str, str]] = set()


def _owning_capture_stream(code: str) -> object | None:
    session = _state.kiwoom_session
    if session is None:
        return None
    for stream in session.capture_streams():
        owns = getattr(stream, "owns_code", None)
        if owns is not None and owns(code):
            return stream
    return None


async def ensure_today_peaks_seeded(
    code: str, venue: str, date: str, *, data_dir: Path,
) -> None:
    """오늘분 최대벽 인메모리 상태가 비어 있으면 그날 JSONL 로 복원한다.

    상태는 프로세스 인메모리라 **재기동으로 사라진다**. 두 가지 모양으로 아프다:
    ① 마감 후 기동 → 오늘 벽이 통째로 없다. ② **장중 재기동 → 재기동 시점 이후로만
    래칫이 쌓여 조용히 과소평가된다**(그럴듯해 보이므로 더 나쁘다). 이 함수가 둘 다
    복구한다 — ②는 살아 있는 상태에 재생본을 **병합**해서(`install_today_peak_seed`).

    재생은 워커 스레드에서 **분리된** 상태에 하고 설치만 루프에서 한다 — 살아 있는 상태를
    스레드에서 변이하면 `on_tick` 과 레이스가 난다(정확히 ② 의 상황이다).

    파일이 없어도 시도한 것으로 표시한다. 장 초반 flush(10초) 전이면 파일이 아직 없을 수
    있는데, 그 구간은 라이브 틱이 어차피 상태를 만들고 있으므로 재시도의 값이 없다 —
    매 요청 디스크를 두드리는 비용만 남는다.
    """
    if date != _today_kst():
        return
    key = (code, venue, date)
    if key in _today_peak_seeded:
        return
    stream = _owning_capture_stream(code)
    if stream is None:
        return
    lock = _today_peak_seed_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if key in _today_peak_seeded:
            return
        from .stream import build_today_peak_seed  # noqa: PLC0415 — stream→lifecycle 순환 절단

        # live_root 는 키움 conn 의 LiveWriter 와 같은 뿌리여야 한다(kiwoom_session
        # `_default_build_conn`). 어긋나면 파일을 못 찾아 조용히 no-op 이 된다.
        seed = await asyncio.to_thread(
            build_today_peak_seed,
            code=code, venue=venue, date=date, live_root=data_dir / "live_kiwoom",
        )
        _today_peak_seeded.add(key)
        if seed is None:
            return
        install = getattr(stream, "install_today_peak_seed", None)
        if install is None:
            return
        outcome = install(code=code, venue=venue, seed=seed)
    _log.info(
        "live.peak.seed code=%s venue=%s date=%s rows=%d %s",
        code, venue, date, seed.rows, outcome,
    )


def get_today_bid_peak(code: str, venue: str) -> dict | None:
    """Return today's bid-peak snapshot for a captured code (키움 스트림)."""
    session = _state.kiwoom_session
    if session is None:
        return None
    for stream in session.capture_streams():
        snapshot = getattr(stream, "bid_peak_snapshot", None)
        if snapshot is None:
            continue
        result = snapshot(code, venue)
        if result is not None:
            return result
    return None


def _now_ms() -> int:
    return int(time.time() * 1000)


def _today_kst() -> str:
    from datetime import datetime  # noqa: PLC0415

    return datetime.now(KST).strftime("%Y%m%d")


def _market_clock_closed_for_capture(now_ms: int) -> bool:
    """캡처 게이트(ws_capture_window)의 순수-시계 근사 — 주말 또는 정규장
    (09:00–15:30 KST) 밖이면 True. get_status는 sync 라우트라 캘린더 HTTP
    (is_trading_session_today)를 못 쓴다. 그래서 순수 weekday+clock으로 'closed'를
    판정해 밤·주말 pill 거짓-앰버를 막는다. 평일 공휴일 장중은 'closed'로 안 잡혀
    reconnecting 앰버로 보이나 드물어 수용(quote 게이트와 동일 트레이드오프)."""
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KST  # noqa: PLC0415
    from .session_gate import market_phase  # noqa: PLC0415

    kst = datetime.fromtimestamp(now_ms / 1000, tz=KST)
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
    elif k.get("registration_incomplete"):
        cap_healthy = False
        cap_reason = "registration_incomplete"
    else:
        cap_healthy = True
        cap_reason = "healthy"

    return LiveStatus(
        running=running,
        started_at_ms=_state.started_at_ms,
        last_tick_ms=last_tick_ms,
        cycle_lag_ms=0,
        watchlist_count=len(live_set),
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=ws_connected,
        live_set=live_set,
        degraded_accounts=degraded_accounts,
        capture_healthy=cap_healthy,
        capture_reason=cap_reason,
        capture_missing_codes=[],
        rest_bypass_enabled=_state.rest_bypass_enabled,
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
    _state.rest_bypass_enabled = settings.rest_bypass_enabled


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

def _resolve_view_venues(code: str, venues: set[str] | None) -> set[str]:
    """뷰 구독 venue 해석 — 미지정(프론트 기본)이면 **그 종목이 가진 venue 전부**.

    AUTO 센티넬의 후계다(ADR-0140 §2). AUTO 는 "시점의 target_ws_venue(now)를 추종"이라는
    뜻이었고 시분할이 사라지며 의미를 잃었다. 대체값을 KRX 하나로 두면 **회귀**다 —
    프론트는 실측 기준 `venues` 를 아예 안 보내므로(전 요청이 이 경로다) 18:00 에
    열람하면 KRX 는 닫혀 있어 화면이 멎는다.

    그래서 "전부"로 간다. 저장셋 종목은 어차피 저장 구독이 세 venue 를 다 덮으므로
    `_covered_by_storage` 가 슬롯을 안 쓴다. 저장셋 밖 종목만 최대 3 슬롯을 쓰는데,
    그건 사용자가 지금 보고 있는 소수다.

    명시적 {KRX}/{NXT}/{UN}(열람 옵션 직결, PR-H)은 그대로 고정(pin)된다."""
    if venues:
        return venues
    from .coverage import subscription_venues  # noqa: PLC0415 — 순환 절단(지연)
    from .kiwoom_session import _nxt_map  # noqa: PLC0415

    return set(subscription_venues(code, _nxt_map()))


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
    return await session.on_view_subscribe(code, _resolve_view_venues(code, venues), ref=ref or code)


async def on_view_unsubscribe(
    code: str, venues: set[str] | None = None, *, ref: str | None = None,
) -> None:
    """보는종목 구독 해제 신호 — 키움 매니저 표시셋에 위임(ADR-0118 PR-C·PR-G). 키움은
    참조 0이면 유예 후 해제(즉시 아님). venues·ref는 구독 시와 동일하게 ws.py가 전달."""
    session = _state.kiwoom_session
    if session is None:
        return
    await session.on_view_unsubscribe(code, _resolve_view_venues(code, venues), ref=ref or code)


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


#: 업종·지수 실시간 브로드캐스트 주기. **틱마다 보내지 않는 이유**가 이 상수다:
#: 0J 는 지수 상품 기준 초당 ~1틱이고 구독이 68코드라 그대로 흘리면 탭마다 초당 수십
#: 프레임이 된다. 화면은 1초 해상도면 충분하므로(사람이 읽는 숫자다) 여기서 묶는다.
_SECTOR_BROADCAST_INTERVAL_S = 1.0

#: 브로드캐스트가 싣는 필드 — 화면이 실제로 쓰는 것만. 전체 스냅샷을 보내면 시고저·
#: 누적거래량까지 매초 나가는데 어느 카드도 그걸 안 쓴다.
_SECTOR_WIRE_FIELDS = (
    "value", "change", "change_pct", "trade_value_eok",
    "rising", "falling", "flat", "upper", "lower",
)


async def start_sector_broadcast(
    publish: Callable[[dict], None],
    *,
    interval_s: float = _SECTOR_BROADCAST_INTERVAL_S,
) -> asyncio.Task:
    """0J/0U 업종·지수 스냅샷을 **변경분만** 1초 주기로 프론트에 밀어 준다.

    폴링(`/api/market/sectors`, 30s)을 대체하지 않는다 — 그쪽이 baseline 이고 이건
    그 위의 오버레이다. 그래서 이 태스크가 죽어도 화면은 30초 갱신으로 되돌아갈 뿐
    비지 않는다. 반대로 말하면 **죽어도 무증상**이라, 살아 있는지는 `sector_health`
    카운터로만 보인다.

    **변경분만 보내는 것이 load-bearing 이다.** 68코드를 매초 통째로 보내면 장 마감
    후처럼 아무것도 안 변하는 구간에도 초당 한 프레임이 나간다. 값 비교로 걸러 두면
    조용한 시장에서는 트래픽이 0 이 된다.
    """

    last: dict[str, dict] = {}

    async def loop() -> None:
        while True:
            try:
                session = _state.kiwoom_session
                if session is not None:
                    snap = session.sector_snapshot()
                    changed: dict[str, dict] = {}
                    for code, row in snap.items():
                        wire = {k: row.get(k) for k in _SECTOR_WIRE_FIELDS if row.get(k) is not None}
                        if wire and wire != last.get(code):
                            changed[code] = wire
                            last[code] = wire
                    if changed:
                        publish({"type": "market_sector_tick", "sectors": changed})
            except Exception:  # noqa: BLE001 — 오버레이 실패가 폴링까지 죽이면 안 된다
                _log.exception("live.kiwoom.sector_broadcast_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="kiwoom-sector-broadcast")


#: 시간외 마지막 호가 레코더의 주기. 시간외 단일가는 10분 주기로 체결되지만
#: 호가는 계속 접수되므로 그보다 촘촘하게 잡는다. 이 값이 그대로 벤더 유량이 된다 —
#: 종목 N 개면 주기당 N 콜이다.
_AFTER_HOURS_RECORD_INTERVAL_S = 120.0
#: 종목 사이 간격. `ka10087` 버킷의 초당 상한(`kiwoom_capacity.DEFAULT_TR_RATE_PER_SEC`
#: = 5)의 한참 아래로 눌러 둔다 — 이 fetcher 는 거버너를 타지 않으므로(직접 httpx)
#: 페이싱을 여기서 스스로 해야 한다.
_AFTER_HOURS_RECORD_CODE_GAP_S = 0.25


def start_after_hours_recorder(
    data_dir: Path,
    *,
    get_codes: Callable[[], list[str]],
    fetch: Callable[[str], object],
    interval_s: float = _AFTER_HOURS_RECORD_INTERVAL_S,
    code_gap_s: float = _AFTER_HOURS_RECORD_CODE_GAP_S,
) -> asyncio.Task:
    """시간외 단일가 마지막 호가를 일자 파일에 적는 레코더 (16:00–18:00 KST).

    ## 왜 이 태스크가 있는가

    `ka10087` 은 그 창 밖에서 답하지 않는다. 프론트가 그때그때 폴링해 화면에만 들고
    있으므로 **18:00 이 지나거나 새로고침하면 그날 시간외가 사라진다** — 저장하는
    주체가 아무도 없다(WS 경로가 아니라 링버퍼에도 안 쌓인다). 이 루프가 그 구멍만
    닫는다: 창 안에서 주기적으로 훑어 종목당 마지막 한 장을 남긴다.

    ## 대상은 **watchlist ∩ NXT 미상장** 이다

    `get_codes` 가 그 교집합을 준다. NXT 상장 종목을 빼는 것이 load-bearing 이다 —
    그쪽 10호가 창에는 세션 토글이 없어(`bookSessionMode` 갈래 B) 저장해도 화면에
    나올 길이 없고, 애프터마켓 호가는 어차피 WS 로 와서 링버퍼에 쌓인다. 표시되지
    않을 데이터를 위해 자격증명을 쥔 프로세스가 벤더를 치는 것은 이 리포가 반복해서
    대가를 치른 형태다.

    ## ⚠ 유량 — `ka10001` 도 함께 나간다

    `fetch` 는 fetcher 의 `get()` 이고, 그 안에서 `ka10087`(호가)과 `ka10001`(예상체결)을
    **같은 TTL 축에서 친다**. 예상체결을 저장하지도 않으면서 치는 셈이지만, 별도
    경로를 만들지 않는 이유는 그 fetcher 의 TTL 캐시가 `(book, expected)` 를 한 쌍으로
    들고 **프론트 경로와 공유**하기 때문이다 — book 만 담는 경로가 캐시에 `(book, None)`
    을 쓰면 같은 종목을 보고 있는 사용자의 예상체결 배너가 3초 동안 빈다.

    그래서 캐시를 공유한 채 두고 유량만 눌렀다: 2분 주기 × N 종목이면 TR 당 ~0.2 콜/초
    로, 버킷 상한(5/s)의 4% 다. **이 fetcher 는 거버너를 타지 않으므로**(직접 httpx)
    페이싱은 아래 `code_gap_s` 가 스스로 한다.

    ## 실패는 종목 단위로 격리한다

    한 종목이 실패해도 나머지를 계속 훑고, 그 주기의 성공분만 **병합** 저장한다
    (`save_cycle`). 통째 교체면 마감 직전 주기의 부분 실패가 그날 데이터를 날린다.

    ## 마감 캡처를 따로 두지 않는다

    18:00 직전 주기가 곧 마감 캡처다 — 2분 주기면 마지막 실행이 17:58–18:00 에
    들어온다. 별도 시각 트리거를 두면 "창 판정" 이 두 곳으로 갈린다.

    자격증명이 없으면 `fetch` 가 매번 실패해 저장할 것이 없고, 루프는 조용히 돈다.
    호출자가 fetcher 미배선을 알면 아예 시작하지 않는 편이 낫다.
    """
    async def _record_once() -> None:
        codes = get_codes()
        if not codes:
            return
        books: dict[str, StoredAfterHoursBook] = {}
        for i, code in enumerate(codes):
            # ⚠ **간격은 루프 맨 앞에 있어야 한다.** 아래 두 `continue`(fetch 실패 ·
            # 빈 사다리)가 흔한 경로다 — 대부분의 종목에 시간외 주문이 없어 빈
            # 사다리가 정상이다. 간격이 뒤에 있으면 그 종목들이 HTTP 지연(실측
            # 30~170ms)만으로 연달아 나가 초당 5~10콜이 되고, ka10087 버킷의 상한
            # (`kiwoom_capacity.DEFAULT_TR_RATE_PER_SEC` = 5)을 넘는다.
            if i > 0:
                await asyncio.sleep(code_gap_s)
            try:
                view = await fetch(code)  # type: ignore[misc]
            except Exception:  # noqa: BLE001 — 한 종목 실패가 나머지를 막지 않는다
                _log.exception("live.after_hours.record_fetch_failed code=%s", code)
                continue
            book = view.book  # type: ignore[attr-defined]
            # 전 단계가 0 이면 그 종목에 시간외 주문이 없다는 뜻 — 빈 사다리를 저장하면
            # 저녁 조회가 "있는데 비었다" 로 보인다. 라우트가 같은 판정을 한다.
            if not book.has_quotes:
                continue
            books[code] = StoredAfterHoursBook(
                code=code,
                ask=tuple((lv.price, lv.qty) for lv in book.ask),
                bid=tuple((lv.price, lv.qty) for lv in book.bid),
                total_ask_qty=book.total_ask_qty,
                total_bid_qty=book.total_bid_qty,
                cur_price=book.cur_price,
                close_price=book.close_price,
                acc_volume=book.acc_volume,
                base_tm=book.base_tm,
                fetched_at_ms=view.fetched_at_ms,  # type: ignore[attr-defined]
            )
        save_cycle(data_dir, today_kst_yyyymmdd(), books)

    async def loop() -> None:
        while True:
            try:
                if is_after_hours_single_price_window(int(time.time() * 1000)):
                    await _record_once()
            except Exception:  # noqa: BLE001 — 레코더가 죽으면 저녁 조회만 빈다
                _log.exception("live.after_hours.record_cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="after-hours-recorder")



def start_trading_calendar_refresher(
    data_dir,
    *,
    interval_s: float = 6 * 3600.0,
) -> asyncio.Task:
    """거래일 달력 오버레이 갱신 태스크 (PR-H · #1044).

    **조회 경로가 아니라 갱신 경로다.** 조회는 커밋된 시드 + 오버레이 파일만 읽고
    벤더를 부르지 않는다. 이 태스크는 그 오버레이를 키움 `ka20006` 으로 하루씩
    밀어 준다.

    저빈도(6시간)로 충분하다 — 새 거래일은 하루에 하나 늘 뿐이다. 실패해도 조회는
    시드까지 그대로 답하므로 이 태스크의 사망이 달력을 죽이지 않는다. 그게 KIS
    판과 가장 크게 다른 점이다(그쪽은 조회가 곧 원격 호출이라 장애가 곧 조회 실패).
    """
    log = logging.getLogger(__name__)

    async def loop() -> None:
        while True:
            try:
                from hoga.api.trading_days import refresh_overlay  # noqa: PLC0415

                await refresh_overlay(data_dir)
            except Exception:
                # 갱신 실패는 **조회를 막지 않는다** — 시드까지는 그대로 답한다.
                # 다만 반복되면 커버리지가 더 이상 전진하지 않으므로 ERROR 다.
                log.exception("live.trading_calendar.refresh_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="trading-calendar-refresher")
