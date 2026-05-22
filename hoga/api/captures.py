"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import asyncio
import collections
import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from hoga.api import disk_state as _disk_state_module
from hoga.api.disk_state import DiskState
from hoga.api.models import (
    CaptureError,
    CaptureFinishedEvent,
    CapturePhaseEvent,
    CaptureProgress,
    CaptureProgressEvent,
    CaptureQueuedEvent,
    CaptureQueuePausedEvent,
    CaptureQueueResumedEvent,
    CaptureResult,
    EnqueueDedupedRow,
    EnqueueRequest,
    EnqueueResponse,
)
from hoga.api.timeenc import HogaMs, hhmmssms_to_unix_ms
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import (
    CHART_FINAL_TIME_MS,
    DATA_WINDOW_START_MS,
    CancelToken,
    CaptureCancelled,
    ProgressEvent,
    TodayTooEarlyRefused,
    collect_stock_date,
    is_today_too_early,
)
from hoga.config import CookieMissingError
from hoga.parser import parse_stock_date

# Fail fast if someone runs uvicorn multi-worker — see spec §4.4.
# The _latest singleton and asyncio.Lock are per-process; multi-worker would
# silently break (parallel captures, cookie 429s, SSE blind spots).
if int(os.environ.get("WEB_CONCURRENCY", "1")) > 1:
    raise RuntimeError(
        "hoga-ops captures require a single uvicorn worker. "
        "Found WEB_CONCURRENCY > 1. Use `hoga serve` or pass --workers 1."
    )


def _exception_to_error_code(exc: BaseException) -> str | None:
    """Map a Python exception class to the API `code` field.

    Returns None for CaptureCancelled — that produces a `cancelled` phase,
    not a `failed` one.
    """
    if isinstance(exc, TodayTooEarlyRefused):
        return "today_too_early"
    if isinstance(exc, CookieMissingError):
        return "cookie_missing"
    if isinstance(exc, CookieExpiredError):
        return "cookie_expired"
    if isinstance(exc, HogaplayHTTPError):
        return "hogaplay_http_error"
    if isinstance(exc, CaptureCancelled):
        return None
    return "internal_error"


@dataclass
class QueueItemState:
    """Mutable server-side state for one queue item. Not a Wire Model."""
    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    phase: str = "queued"
    pause_origin: bool = False
    started_at_ms: int | None = None
    pages_done: int = 0
    events_seen: int = 0
    frontier: HogaMs = HogaMs(0)  # collector encoding (HHMMSSmmm); see ADR-0003
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: str | None = None
    cancel_token: Any = None

    def to_progress(self) -> CaptureProgress | None:
        if self.pages_done == 0:
            return None
        return CaptureProgress(
            pages_done=self.pages_done,
            events_seen=self.events_seen,
            frontier_ms=hhmmssms_to_unix_ms(self.date, self.frontier),
            estimate_pct=self.estimate_pct,
            elapsed_ms=self.elapsed_ms,
        )

    def event_header(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "code": self.code,
            "date": self.date,
            "phase": self.phase,
        }

    def to_wire(self):
        from hoga.api.models import QueueItem
        return QueueItem(
            item_id=self.item_id,
            code=self.code,
            date=self.date,
            phase=self.phase,                # type: ignore[arg-type]
            force_retry=self.force_retry,
            pause_origin=self.pause_origin,
            enqueued_at_ms=self.enqueued_at_ms,
            started_at_ms=self.started_at_ms,
            progress=self.to_progress(),
            result=self.result,
            error=self.error,
            skip_reason=self.skip_reason,    # type: ignore[arg-type]
        )

    @property
    def is_terminal(self) -> bool:
        return self.phase in ("done", "failed", "cancelled", "skipped")


_lock = asyncio.Lock()

# --- Queue state singletons (Plan B) ---------------------------------------

_queue: collections.deque[Any] = collections.deque()    # deque[QueueItemState]
_active: dict[str, Any] = {}                            # item_id → QueueItemState
_done: list[Any] = []                                   # terminal items, cleared by DELETE /done
_inflight_paths: set[tuple[str, str]] = set()           # (code, date) — see spec §11 Q15 Layer 2
_queue_paused: bool = False
_max_concurrent: int = int(os.environ.get("HOGA_MAX_CONCURRENT", "3"))
_wakeup: asyncio.Event | None = None                    # lazily constructed when the first worker starts
_workers: list[asyncio.Task] = []                       # populated by app lifespan; stopped on shutdown

# Production dependencies set during build_router(); sentinels keep the names
# valid before init (e.g. for tests that bypass build_router via the
# _data_dir_for_tests / _client_factory_for_tests injection seams below).
_data_dir: Path | None = None
_client_factory: Callable[[], object] | None = None

# Test injection seams — production replaces these via build_router() globals.
_data_dir_for_tests: Callable[[], Path] | None = None
_client_factory_for_tests: Callable[[], Any] | None = None


def _resolve_data_dir() -> Path:
    if _data_dir_for_tests is not None:
        return _data_dir_for_tests()
    # build_router() sets _data_dir; if unset, that's a programming error.
    assert _data_dir is not None, "captures._data_dir not initialized; call build_router()"
    return _data_dir


def _resolve_client_factory() -> Callable[[], Any]:
    if _client_factory_for_tests is not None:
        return _client_factory_for_tests
    assert _client_factory is not None, "captures._client_factory not initialized; call build_router()"
    return _client_factory


def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears all module singletons."""
    global _queue_paused, _wakeup  # noqa: PLW0603 — intentional test-only reset of module singletons
    _queue.clear()
    _active.clear()
    _done.clear()
    _inflight_paths.clear()
    _queue_paused = False
    # _wakeup is an asyncio.Event bound to an event loop — pytest-asyncio
    # creates a fresh loop per test, so we must drop the stale Event or the
    # next test gets "bound to a different event loop" errors. Workers
    # construct one lazily in start_workers().
    _wakeup = None


def cancel_all_on_shutdown() -> None:
    """Best-effort cancel called from app lifespan teardown.

    Cancels every active queue item's cancel_token. Raw pages on disk are
    preserved for the user to Resume; the asyncio tasks are abandoned (the
    server is going down anyway). See spec §9 'server restart loses state'.
    """
    for s in _active.values():
        if s.cancel_token is not None:
            s.cancel_token.cancel()


# Bus injection point: the captures router holds a reference to the SSE _Bus
# AND the event loop, because the collector runs in a thread executor and its
# on_progress callback fires from the worker thread, NOT the event loop.
# asyncio.Queue.put_nowait is not loop-safe across threads — same reason the
# existing watchdog handler in sse.py:57 uses loop.call_soon_threadsafe.
_bus: Any = None
_loop: asyncio.AbstractEventLoop | None = None


def set_bus(bus: Any, loop: asyncio.AbstractEventLoop | None = None) -> None:
    """Wired from app.py during startup; see Task 10.

    `loop` is required for thread-safe publishes from the executor thread.
    Passing None turns _publish into a no-op (test mode).
    """
    global _bus, _loop  # noqa: PLW0603 — intentional module-level injection point
    _bus = bus
    _loop = loop


def _publish_event(event: BaseModel) -> None:
    """Thread-safe publish of a typed SSE event Wire Model.

    Two responsibilities, intentionally fused:
    (1) Serialize the pydantic model to a dict (the bus is type-blind, takes
        dicts only — preserves backwards compat with the inventory event path
        that still emits dicts directly).
    (2) Thread-safety: the on_progress callback fires from the collector's
        executor thread; asyncio.Queue.put_nowait is not loop-safe, so we hop
        to the event loop via call_soon_threadsafe. Same pattern as the
        watchdog handler in sse.py.

    No-op when bus/loop aren't wired (test mode).
    """
    if _bus is None or _loop is None:
        return
    _loop.call_soon_threadsafe(_bus.publish, event.model_dump(mode="json"))


def _apply_progress(state: QueueItemState, evt: ProgressEvent) -> None:
    """Apply a ProgressEvent to `state` and emit the SSE event.

    Single-thread invariant: this function MUST only run on the event loop.
    Callers from the collector's executor thread go through
    _make_progress_callback, which hops to the loop via call_soon_threadsafe.
    Concentrating all state mutation in one thread eliminates the race window
    between mutation and concurrent reads (GET /latest, state.to_wire()).

    Conversion seam (spec §4.3 + ADR-0003): HHMMSSmmm → Unix-ms happens HERE,
    not in the collector.
    """
    state.pages_done = evt.pages_done
    state.events_seen = evt.events_seen
    state.frontier = evt.frontier
    state.elapsed_ms = int(time.time() * 1000) - (state.started_at_ms or 0)
    # Estimate: % of Data Window covered. HogaMs arithmetic returns int
    # (NewType subtraction is identity), so span/offset are plain ints.
    span = CHART_FINAL_TIME_MS - DATA_WINDOW_START_MS
    offset = max(0, evt.frontier - DATA_WINDOW_START_MS)
    state.estimate_pct = min(98, max(0, int(100 * offset / span)))
    progress = state.to_progress()
    assert progress is not None  # pages_done > 0 since on_progress just fired
    _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))


def _make_progress_callback(state: QueueItemState):
    """Returns a callback the collector invokes from its executor thread.

    The callback does NOT mutate state directly — it hops to the event loop
    so all state mutation lives on a single thread. If _loop is unwired
    (test-mode mutation without a running loop), mutation happens inline as
    a fallback so unit tests can verify behavior without spinning up uvicorn.
    """
    def _on_progress(evt: ProgressEvent) -> None:
        if _loop is None:
            # Test-mode fallback: no loop wired → apply inline so unit tests
            # that exercise the collector path can assert against state.
            _apply_progress(state, evt)
            return
        _loop.call_soon_threadsafe(_apply_progress, state, evt)
    return _on_progress


KST = timezone(timedelta(hours=9))


from hoga.api.models import QueueSnapshot  # noqa: E402 — placed near consumers to mirror the existing late-import style


def get_queue_snapshot() -> QueueSnapshot:
    """Build the wire-side snapshot of queue/active/done. Read-only."""
    return QueueSnapshot(
        active=[s.to_wire() for s in _active.values()],
        queued=[s.to_wire() for s in _queue],
        done=[s.to_wire() for s in _done],
        paused=_queue_paused,
        max_concurrent=_max_concurrent,
    )


async def _publish_phase(state: QueueItemState) -> None:
    _publish_event(CapturePhaseEvent(**state.event_header()))


_BACKOFF_DELAYS: tuple[float, ...] = (5.0, 10.0, 30.0)


async def _cancel_aware_sleep(state: QueueItemState, delay: float) -> bool:
    """Sleep `delay` seconds but return True if state.cancel_token signals.

    Uses asyncio.wait_for on CancelToken._event (asyncio.Event) so we react
    immediately to a cancel rather than polling. Accessing the private
    ``_event`` attr is intentional — that's why CancelToken exposes one.
    """
    if state.cancel_token is None:
        await asyncio.sleep(delay)
        return False
    if state.cancel_token.cancelled:
        return True
    try:
        await asyncio.wait_for(state.cancel_token._event.wait(), timeout=delay)
        return True
    except asyncio.TimeoutError:
        return False


async def _run_capture_and_parse(state: QueueItemState, resume: bool) -> None:
    """Wrap ``_run_capture_inner`` with 429 exponential backoff.

    3 retries (5/10/30s) then propagate. Cancellation during the sleep raises
    ``CaptureCancelled``, caught by the worker loop. Public symbol preserved
    so earlier tests (Tasks 5/6/9/10) that monkeypatch this name keep working
    — Task 11 backoff is INTERNAL.
    """
    from hoga.collector.orchestrator import CaptureCancelled
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    last_exc: BaseException | None = None
    for delay in (*_BACKOFF_DELAYS, None):
        try:
            await _run_capture_inner(state, resume=resume)
            return
        except HogaplayHTTPError as exc:
            if exc.status_code != 429 or delay is None:
                raise
            last_exc = exc
            if await _cancel_aware_sleep(state, delay):
                raise CaptureCancelled() from exc
    if last_exc is not None:
        raise last_exc


async def _run_capture_inner(state: QueueItemState, resume: bool) -> None:
    """Run the collector then the parser. Cookie-missing/expired rejection
    happens via the cookie-pause path in the worker loop. Task 11's
    ``_run_capture_and_parse`` wrapper provides 429 backoff around this.
    """
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    data_dir = _resolve_data_dir()
    client = _resolve_client_factory()()

    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    await _publish_phase(state)

    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(
        None,
        lambda: collect_stock_date(
            client=client,
            code=state.code,
            date=state.date,
            data_dir=data_dir,
            rate_limit_s=0.0 if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1" else 0.2,
            resume=resume,
            on_progress=_make_progress_callback(state),
            cancel_token=state.cancel_token,
        ),
    )

    state.phase = "parsing"
    await _publish_phase(state)
    await loop.run_in_executor(
        None,
        lambda: parse_stock_date(
            code=state.code, date=state.date, data_dir=data_dir, lenient=False,
        ),
    )

    state.result = CaptureResult(
        pages_written=result.pages_written,
        unique_events=result.unique_events,
        raw_dir=str(result.raw_dir),
        parsed=True,
    )
    state.phase = "done"


async def _run_item(state: QueueItemState) -> None:
    """Full pipeline: deciding → (skipped | capturing → parsing → done).

    Disk-state branches (see spec §5.2 + §11 Q16):
    - COMPLETE → skipped/already_complete
    - SOURCE_PARTIAL + not force_retry → skipped/source_partial
    - SOURCE_PARTIAL + force_retry → fresh capture (resume=False)
    - CLIENT_INCOMPLETE → resume=True (continue from existing pages)
    - NONE → fresh capture (resume=False)
    """
    data_dir = _resolve_data_dir()
    # Late attribute lookup so tests can monkeypatch
    # "hoga.api.disk_state.check_disk_state" at the source module.
    disk = _disk_state_module.check_disk_state(data_dir, state.code, state.date)

    if disk == DiskState.COMPLETE:
        state.phase = "skipped"
        state.skip_reason = "already_complete"
        return
    if disk == DiskState.SOURCE_PARTIAL and not state.force_retry:
        state.phase = "skipped"
        state.skip_reason = "source_partial"
        return

    resume_flag = (disk == DiskState.CLIENT_INCOMPLETE)
    await _run_capture_and_parse(state, resume=resume_flag)


async def _finalize_item(state: QueueItemState) -> None:
    """Move state into _done, publish finished, wake other workers, emit
    drained if applicable."""
    from hoga.api.models import CaptureQueueDrainedEvent
    async with _lock:
        _active.pop(state.item_id, None)
        _inflight_paths.discard((state.code, state.date))
        _done.append(state)
        # Drain detection — also check we're not paused (drained only fires
        # when the queue has naturally bottomed out).
        drained_event: CaptureQueueDrainedEvent | None = None
        if not _queue and not _active and not _queue_paused:
            totals = {
                "total_done": sum(1 for s in _done if s.phase == "done"),
                "total_failed": sum(1 for s in _done if s.phase == "failed"),
                "total_cancelled": sum(1 for s in _done if s.phase == "cancelled"),
                "total_skipped": sum(1 for s in _done if s.phase == "skipped"),
            }
            drained_event = CaptureQueueDrainedEvent(**totals)
        if _wakeup is not None:
            _wakeup.set()
    if drained_event is not None:
        _publish_event(drained_event)
    _publish_event(CaptureFinishedEvent(
        **state.event_header(),
        result=state.result,
        error=state.error,
        skip_reason=state.skip_reason,  # type: ignore[arg-type]
    ))


async def _handle_cookie_expired(state: QueueItemState) -> None:
    """Pause the pool atomically. Cancels OTHER active items with pause_origin=True.

    Idempotent — second call while already paused is a no-op. The triggering
    item's phase/error were set by the caller (the worker loop). All other
    active items are marked pause_origin so resume_queue() can re-enqueue
    them at the FRONT.
    """
    global _queue_paused  # noqa: PLW0603 — module singleton write under _lock
    async with _lock:
        if _queue_paused:
            return
        _queue_paused = True
        for other in _active.values():
            if other.item_id == state.item_id:
                continue
            other.pause_origin = True
            if other.cancel_token is not None:
                other.cancel_token.cancel()
    _publish_event(CaptureQueuePausedEvent(
        reason="cookie_expired",
        message="Cookie expired — pool paused. Refresh .cookie and POST /api/captures/queue/resume.",
    ))


async def resume_queue() -> None:
    """Re-queue pause_origin items from _done to the FRONT (appendleft).
    Clears _queue_paused and wakes workers.
    """
    global _queue_paused  # noqa: PLW0603 — module singleton write under _lock
    async with _lock:
        _queue_paused = False
        # Items cancelled BY the pause go back to the front of the queue.
        to_reenqueue = [s for s in _done if s.pause_origin and s.phase == "cancelled"]
        for s in reversed(to_reenqueue):
            s.phase = "queued"
            s.pause_origin = False
            _queue.appendleft(s)
        # Remove them from _done.
        _done[:] = [s for s in _done if s not in to_reenqueue]
        if _wakeup is not None and _queue:
            _wakeup.set()
    _publish_event(CaptureQueueResumedEvent(reason="user_resume"))


async def cancel_all() -> dict:
    """Drain queue + cancel all active. Q20 semantics in paused state:
    downgrade pause_origin cancelled items to plain cancelled + clear pause flag.
    """
    global _queue_paused  # noqa: PLW0603 — module singleton write under _lock
    was_paused = False
    drained: list[QueueItemState] = []
    async with _lock:
        was_paused = _queue_paused
        while _queue:
            s = _queue.popleft()
            s.phase = "cancelled"
            _done.append(s)
            drained.append(s)
        for s in list(_active.values()):
            if s.cancel_token is not None:
                s.cancel_token.cancel()
        if was_paused:
            for s in _done:
                if s.pause_origin:
                    s.pause_origin = False
            _queue_paused = False
        if _wakeup is not None:
            _wakeup.set()
    for s in drained:
        _publish_event(CaptureFinishedEvent(
            **s.event_header(),
            result=None,
            error=None,
            skip_reason=None,
        ))
    if was_paused:
        _publish_event(CaptureQueueResumedEvent(reason="cancel_all"))
    return {
        "status": "cancel_all_delivered",
        "drained_count": len(drained),
        "was_paused": was_paused,
    }


async def _worker_loop() -> None:
    """One of N coroutines. Pulls items off _queue under the lock, runs each,
    finalizes."""
    global _wakeup  # noqa: PLW0603
    while True:
        async with _lock:
            if _queue_paused or len(_active) >= _max_concurrent or not _queue:
                if _wakeup is None:
                    _wakeup = asyncio.Event()
                wait = _wakeup.wait()
                state = None
            else:
                state = _queue.popleft()
                # Q15 Layer 2: per-(code, date) inflight lock.
                if (state.code, state.date) in _inflight_paths:
                    # Collision — requeue to back, do not occupy a slot.
                    _queue.append(state)
                    state = None
                    wait = None
                else:
                    _inflight_paths.add((state.code, state.date))
                    state.phase = "deciding"
                    _active[state.item_id] = state
                    wait = None
        if wait is not None:
            await wait
            async with _lock:
                if _wakeup is not None:
                    _wakeup.clear()
            continue
        if state is None:
            # Requeued; yield so other workers / the requeued slot can proceed.
            await asyncio.sleep(0)
            continue
        # Outside the lock: notify deciding, run, finalize.
        await _publish_phase(state)
        try:
            await _run_item(state)
        except CookieExpiredError as exc:
            state.error = CaptureError(
                code="cookie_expired",
                message=str(exc),
                at_page=state.pages_done or None,
            )
            state.phase = "failed"
            await _handle_cookie_expired(state)
        except CaptureCancelled:
            state.phase = "cancelled"
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001 — terminal path
            state.error = CaptureError(
                code=_exception_to_error_code(exc) or "internal_error",
                message=str(exc),
                at_page=state.pages_done or None,
            )
            state.phase = "failed"
        await _finalize_item(state)


def start_workers(n: int | None = None) -> list[asyncio.Task]:
    """Spin up the worker pool. Idempotent in test scope only — production
    lifespan calls this exactly once.

    Always replaces ``_wakeup`` so the Event is bound to the currently
    running event loop. Otherwise sequential FastAPI TestClient lifespans
    across tests would inherit a stale Event and ``stop_workers`` would
    raise "bound to a different event loop" when teardown tries to await
    on the worker tasks still waiting on the old Event.
    """
    global _wakeup  # noqa: PLW0603
    _wakeup = asyncio.Event()
    n = n if n is not None else _max_concurrent
    return [asyncio.create_task(_worker_loop(), name=f"capture-worker-{i}") for i in range(n)]


async def stop_workers(workers: list[asyncio.Task]) -> None:
    for w in workers:
        w.cancel()
    for w in workers:
        try:
            await w
        except asyncio.CancelledError:
            pass


async def wait_drained() -> None:
    """Block until both _queue and _active are empty (and not paused).
    Used by tests; production code listens for the SSE event instead."""
    while True:
        async with _lock:
            done = not _queue and not _active and not _queue_paused
        if done:
            return
        await asyncio.sleep(0.01)


def _now_kst() -> datetime:
    """Wall-clock now() in KST. Wrapped so tests can monkeypatch."""
    return datetime.now(tz=KST)


def _expand_to_trading_days(start: str, end: str) -> list[str]:
    """Return YYYYMMDD strings for each KRX trading day in [start, end].

    Delegates to hoga.api.calendar.trading_days_in_range which owns the
    pykrx-backed cache (Task 15). Late import so tests can monkeypatch
    the calendar function source.
    """
    from hoga.api.calendar import trading_days_in_range
    return trading_days_in_range(start, end)


def _make_item_id(code: str, date: str) -> str:
    """Stable per-enqueue item id: YYYYMMDDTHHMMSSmmm-CODE-DATE."""
    stamp = _now_kst().strftime("%Y%m%dT%H%M%S%f")[:-3]  # ms precision
    return f"{stamp}-{code}-{date}"


def build_router(
    *,
    data_dir: Path,
    client_factory: Callable[[], object],
) -> APIRouter:
    """Build the captures router.

    `client_factory()` returns a fresh HogaplayClientProto. In production this
    yields a real HogaplayClient; tests inject a fake.
    """
    global _data_dir, _client_factory  # noqa: PLW0603 — production wiring of module globals
    _data_dir = data_dir
    _client_factory = client_factory
    router = APIRouter(prefix="/api/captures", tags=["captures"])

    @router.get("/queue")
    async def get_queue() -> QueueSnapshot:
        return get_queue_snapshot()

    @router.post("/items", status_code=201)
    async def enqueue_items(req: EnqueueRequest) -> EnqueueResponse:
        """Enqueue items for one (code, range or dates) request.

        Q14 guard: any date in the request equal to today_kst with
        now.hour < 18 → 400 today_too_early.
        Q15 Layer 1: per-(code, date) dedupe against
        _queue ∪ _active ∪ _inflight_paths and within-request duplicates.
        Returns the dedupe list in the response.
        """
        # 1. Expand to a flat list of candidate dates.
        if req.dates is not None:
            candidate_dates = list(req.dates)
        elif req.start_date and req.end_date:
            candidate_dates = _expand_to_trading_days(req.start_date, req.end_date)
        else:
            raise HTTPException(status_code=400, detail={
                "code": "missing_range",
                "message": "Provide either dates=[...] or start_date+end_date.",
            })

        # 2. Q14 today-too-early guard.
        now = _now_kst()
        too_early = [d for d in candidate_dates if is_today_too_early(d, now)]
        if too_early:
            raise HTTPException(status_code=400, detail={
                "code": "today_too_early",
                "message": (
                    f"Dates {too_early} are today (KST) and now.hour={now.hour} < 18."
                ),
                "dates": too_early,
            })

        # 3. Q15 Layer 1 dedupe: against queue ∪ active ∪ inflight ∪ within-request.
        enqueued: list[QueueItemState] = []
        deduped_rows: list[EnqueueDedupedRow] = []
        enqueued_at_ms = int(time.time() * 1000)
        async with _lock:
            active_pairs = {(s.code, s.date) for s in _active.values()}
            queue_pairs = {(s.code, s.date) for s in _queue}
            existing_pairs = set(_inflight_paths) | queue_pairs | active_pairs
            seen_in_request: set[tuple[str, str]] = set()
            for date in candidate_dates:
                pair = (req.code, date)
                if pair in existing_pairs or pair in seen_in_request:
                    reason = (
                        "already_running" if pair in active_pairs
                        else "already_in_queue"
                    )
                    deduped_rows.append(EnqueueDedupedRow(
                        code=req.code, date=date, reason=reason,
                    ))
                    continue
                seen_in_request.add(pair)
                state = QueueItemState(
                    item_id=_make_item_id(req.code, date),
                    code=req.code,
                    date=date,
                    force_retry=req.force_retry,
                    enqueued_at_ms=enqueued_at_ms,
                )
                _queue.append(state)
                enqueued.append(state)
            if enqueued and _wakeup is not None:
                _wakeup.set()

        # 4. Emit queued event (skipped when nothing landed).
        if enqueued:
            _publish_event(CaptureQueuedEvent(items=[s.to_wire() for s in enqueued]))

        return EnqueueResponse(
            enqueued=[s.to_wire() for s in enqueued],
            deduped=deduped_rows,
        )

    @router.post("/items/{item_id}/cancel", status_code=202)
    async def cancel_item(item_id: str) -> dict:
        async with _lock:
            # Queued case — drop from _queue, mark cancelled, push to _done.
            for i, s in enumerate(_queue):
                if s.item_id == item_id:
                    del _queue[i]
                    s.phase = "cancelled"
                    _done.append(s)
                    if _wakeup is not None:
                        _wakeup.set()
                    _publish_event(CaptureFinishedEvent(
                        **s.event_header(),
                        result=None,
                        error=None,
                        skip_reason=None,
                    ))
                    return {"status": "cancelled", "item_id": item_id}
            # Active case — signal cancel; worker observes via cancel_token.
            state = _active.get(item_id)
            if state is not None and state.cancel_token is not None:
                state.cancel_token.cancel()
                return {"status": "cancel_signal_delivered", "item_id": item_id}
            # Terminal case.
            for s in _done:
                if s.item_id == item_id:
                    raise HTTPException(status_code=409, detail={
                        "code": "terminal", "phase": s.phase,
                    })
        raise HTTPException(status_code=404, detail={"code": "not_found"})

    @router.post("/cancel-all", status_code=202)
    async def cancel_all_route() -> dict:
        return await cancel_all()

    @router.post("/queue/resume", status_code=200)
    async def resume_route() -> dict:
        await resume_queue()
        return {"status": "resumed"}

    @router.delete("/done", status_code=204)
    async def dismiss_done() -> None:
        async with _lock:
            _done.clear()

    return router
