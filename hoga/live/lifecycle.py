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

from pydantic import BaseModel, Field

from . import kis_runtime  # needed by reset_for_tests() + start_live_stream
from .buffer import LiveBuffer
from .promote import promote_today

_log = logging.getLogger(__name__)


# ── Live Set constants (spec §4·§5.1) ─────────────────────────────────────────

KIS_WS_MAX_REGISTRATIONS = 41   # appkey당, (tr_id, code) 쌍 기준 — spec §4 검증 완료
TRS_PER_CODE = 3                # 호가 + 체결 + 회원사(H0STMBC0)
LIVE_SET_MAX_CODES = KIS_WS_MAX_REGISTRATIONS // TRS_PER_CODE  # = 13


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


def _compute_live_set(data_dir: Path) -> list[str]:
    """Live Set 산출 파이프라인(start/refresh 공용 — Task 11 리뷰 이월):
    load_document → 표시 순서 평탄화 → symbol-master 필터(cold cache 무필터
    폴백 — poller 시절과 동일 정책, dropped 경고 포함) → 상위 13 절단."""
    from hoga.api import symbols as _symbols  # noqa: PLC0415
    from hoga.api.watchlist import load_document  # noqa: PLC0415

    ordered = display_ordered_codes(load_document(data_dir))
    known = {h.code for h in _symbols.search("", limit=10_000)}
    if known:
        dropped = [c for c in ordered if c not in known]
        if dropped:
            _log.warning("live.stream.codes_unknown dropped=%r", dropped)
        ordered = [c for c in ordered if c in known]
    return ordered[:LIVE_SET_MAX_CODES]


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


# ── State ──────────────────────────────────────────────────────────────────────

@dataclass
class _State:
    """In-process state of the live stream. Mutated only via this module."""

    started_at_ms: int | None = None
    watchlist_codes: tuple[str, ...] = field(default_factory=tuple)
    # Stream (WS) path (Task 11; poller 슬롯은 Task 13에서 은퇴):
    stream_task: asyncio.Task | None = None   # type: ignore[type-arg]
    stream_obj: object | None = None          # LiveStream — typed `object` to avoid cycle
    ws_task: asyncio.Task | None = None       # type: ignore[type-arg]
    live_set: tuple[str, ...] = field(default_factory=tuple)


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


def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call.

    ADR-0064: `running` reflects TASK LIVENESS (stream task).
    """
    task = _state.stream_task
    running = task is not None and not task.done()

    # WS-specific attributes (stream path)
    stream = _state.stream_obj
    ws_connected = False
    last_tick_ms: int | None = None
    if stream is not None:
        ws = getattr(stream, "ws", None)
        if ws is not None:
            ws_connected = getattr(ws, "connected", False)
            # 데이터 프레임 전용 신호만 노출(리뷰 Important 1-3): last_flush_ms는
            # 틱 0건이어도 10초마다 갱신되므로 폴백하면 '마지막 데이터 활동'으로
            # 오인된다. 틱이 아직 없으면 정직하게 None (wire 모델은 nullable).
            last_tick_ms = getattr(ws, "last_tick_ms", None)

    return LiveStatus(
        running=running,
        started_at_ms=_state.started_at_ms,
        last_tick_ms=last_tick_ms,
        cycle_lag_ms=0,  # poller-era — stream에선 무의미(별도 신호: ws_connected/last_recv)
        watchlist_count=len(_state.watchlist_codes),
        kis_calls_today=0,  # poller-era — WS 캡처는 REST 비사용(LiveStatus 주석 참조)
        kis_rate_limit_remaining=None,  # KIS doesn't expose this header
        today_promote_last_ms=get_today_promote_last_ms(),
        transport="ws",
        ws_connected=ws_connected,
        live_set=list(_state.live_set),
    )


def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state, _buffer  # noqa: PLW0603 — test-only reset of module singletons
    for task in (_state.stream_task, _state.ws_task):
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


async def _start_live_stream_locked(*, data_dir: Path) -> bool:
    """start의 본체 — 호출자가 _lifecycle_lock을 보유한 상태에서만 부른다
    (_stop_live_stream_locked와 동일 패턴). refresh_live_stream의
    never-started 폴백이 공유한다(리뷰 #1)."""
    from datetime import datetime, timedelta, timezone  # noqa: PLC0415

    from .stream import LiveStream  # noqa: PLC0415
    from .writer import LiveWriter  # noqa: PLC0415
    from .ws_client import KisWsClient  # noqa: PLC0415

    # 1-3. Live Set 산출(공용 파이프라인)
    codes = _compute_live_set(data_dir)
    if not codes:
        return False

    # 4. 기존 stream 정지 (락 보유 중 — 잠금 없는 내부 헬퍼)
    await _stop_live_stream_locked()

    # 5. KIS 싱글턴
    kis = kis_runtime.ensure_kis_client_from_env(data_dir)
    if kis is None:
        return False

    def _today_kst() -> str:
        return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")

    # 6. stream + ws 조립
    stream = LiveStream(
        buffer=_buffer,
        writer=LiveWriter(data_dir / "live"),
        date_fn=_today_kst,
    )
    # on_tick 활성 집합 필터를 t0부터 배선(리뷰 #6) — refresh 이전에도
    # 비구독 코드의 잔여 프레임이 다운샘플러 상태를 만들지 못하게 한다.
    stream.set_active_codes(set(codes))
    from .session_gate import ws_capture_window  # noqa: PLC0415

    ws = KisWsClient(
        approval_key_fn=kis.get_approval_key,
        on_tick=stream.on_tick,
        date_fn=_today_kst,
        gate_fn=lambda: ws_capture_window(_now_ms()),
    )
    stream.ws = ws

    global _state  # noqa: PLW0603
    _state = _State(
        started_at_ms=_now_ms(),
        watchlist_codes=tuple(codes),
        live_set=tuple(codes),
        stream_obj=stream,
        ws_task=asyncio.create_task(ws.run(codes), name="live-ws"),
        stream_task=asyncio.create_task(stream.run_flush_loop(), name="live-flush"),
    )
    return True


async def _stop_live_stream_locked() -> None:
    """stop의 본체 — 호출자가 _lifecycle_lock을 보유한 상태에서만 부른다."""
    global _state  # noqa: PLW0603
    for task in (_state.ws_task, _state.stream_task):
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                # M4: 외부에서 *우리*가 취소된 경우 흡수하면 shutdown hang —
                # 자식 task의 취소만 삼키고, 현재 task의 취소는 전파한다.
                cur = asyncio.current_task()
                if cur is not None and cur.cancelling():
                    raise
            except Exception:  # noqa: BLE001
                pass
    _state = _State()


async def stop_live_stream() -> None:
    """stop_live_poller와 동일 패턴 — KisClient 싱글턴은 건드리지 않는다."""
    async with _lifecycle_lock:
        await _stop_live_stream_locked()


async def refresh_live_stream(*, data_dir: Path) -> None:
    """watchlist 변경(추가/삭제/reorder) 후크 — Live Set diff를 WS에 반영.

    start_live_stream과 동일 파이프라인(_compute_live_set)으로 재계산하고,
    _lifecycle_lock으로 start/stop과 직렬화한다(Task 11 리뷰 이월).
    """
    global _state  # noqa: PLW0603 — declared first; _state is both read and reassigned

    async with _lifecycle_lock:
        stream = _state.stream_obj
        if stream is None or stream.ws is None:  # type: ignore[union-attr]
            # never-started 폴백(리뷰 #1): 빈 watchlist 부팅 등으로 기동하지
            # 못한 스트림은 첫 watchlist 변경이 곧 기동 신호다 — 구
            # refresh_live_poller의 auto-start 승계. 가드(빈 코드·creds 없음)는
            # _start_live_stream_locked가 그대로 수행하므로 무해하게 no-op된다.
            await _start_live_stream_locked(data_dir=data_dir)
            return

        codes = _compute_live_set(data_dir)
        # M5: 빈 watchlist면 codes=[] → 전 종목 unsubscribe 후 0구독 idle 연결
        # 유지(정지 아님 — poller와 의도적 차이). 재추가 시 즉시 재구독 가능.

        await stream.ws.update_codes(codes)  # type: ignore[union-attr]
        stream.set_active_codes(set(codes))  # type: ignore[union-attr]  # advisor C: 밀려난 코드 carry 즉시 제거
        await _buffer.drop_codes_except(set(codes))  # Task 4 리뷰: 떠난 코드 ring 해제

        _state = replace(_state, live_set=tuple(codes), watchlist_codes=tuple(codes))


# ADR-0064 이식 — WS 스트림 watchdog
async def _ws_watchdog_check(
    *, data_dir: Path, now_ms: int, stale_after_ms: int
) -> bool:
    """One WS watchdog pass. Returns True iff it restarted the stream.

    _live_watchdog_check를 stream 계열로 복제·수정:
    - dead = ws_task OR stream_task 중 done()
    - stale 신호 = stream_obj.ws.last_recv_ms (리뷰 Important 1):
      last_flush_ms는 틱 0건이어도 10초마다 갱신되고 last_tick_ms는 데이터
      프레임 전용 — half-open TCP에서 recv()가 영구 블록하는 silent stall은
      모든 수신 프레임(KIS 주기 PINGPONG 포함)에 스탬프되는 last_recv_ms로만
      감지된다. 연결 후 무수신이면 None → grace 경과 시 stale.
    - 재시작은 start_live_stream
    - 게이트 판정은 ws_capture_window (advisor B — 15:30 이후엔 재시작 금지)
    - 세션-open 기준 grace 로직은 _live_watchdog_check와 동일
    """
    from datetime import datetime  # noqa: PLC0415

    from .kis_client import KIS_KST  # noqa: PLC0415
    from .session_gate import ws_capture_window  # noqa: PLC0415

    # to_thread 격리(리뷰 #2): 캘린더 게이트의 동기 KIS HTTP가 30초 주기
    # watchdog pass마다 이벤트 루프를 동결시키지 않도록.
    if not await asyncio.to_thread(ws_capture_window, now_ms):
        return False
    started = _state.started_at_ms
    if started is None:
        return False

    # stream_task 또는 ws_task 중 하나라도 done이면 dead
    ws_task = _state.ws_task
    stream_task = _state.stream_task
    dead = (
        (ws_task is None or ws_task.done()) or
        (stream_task is None or stream_task.done())
    )

    # 세션 기준 grace — _live_watchdog_check와 동일 로직
    kst = datetime.fromtimestamp(now_ms / 1000, tz=KIS_KST)
    session_open_ms = int(
        kst.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000
    )
    ref_ms = max(started, session_open_ms)

    stream = _state.stream_obj
    ws = getattr(stream, "ws", None) if stream is not None else None
    last_recv = getattr(ws, "last_recv_ms", None) if ws is not None else None

    grace_elapsed = (now_ms - ref_ms) > stale_after_ms
    recv_fresh = (
        last_recv is not None
        and last_recv >= session_open_ms
        and (now_ms - last_recv) <= stale_after_ms
    )
    stale = (not dead) and grace_elapsed and (not recv_fresh)
    if dead or stale:
        _log.warning(
            "live.stream.watchdog_restart dead=%s stale=%s last_recv_ms=%s",
            dead, stale, last_recv,
        )
        await start_live_stream(data_dir=data_dir)
        return True
    return False


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
