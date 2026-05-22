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
from pydantic import BaseModel, Field

from hoga.api.models import (
    CaptureError,
    CaptureFinishedEvent,
    CaptureJob,
    CapturePhaseEvent,
    CaptureProgress,
    CaptureProgressEvent,
    CaptureResult,
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
class CaptureJobState:
    """Mutable server-side state for the current/last job. Not a Wire Model."""
    job_id: str
    code: str
    date: str
    options: dict[str, Any]
    phase: str = "capturing"
    started_at_ms: int = 0
    pages_done: int = 0
    events_seen: int = 0
    frontier: HogaMs = HogaMs(0)  # collector encoding (HHMMSSmmm); see ADR-0003
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    cancel_token: Any = None  # CancelToken; typed loosely to avoid circular import
    task: asyncio.Task | None = None

    def to_progress(self) -> CaptureProgress | None:
        """Build the wire-side CaptureProgress for this state, or None if no
        page has completed yet. Owns the HHMMSSmmm → Unix-ms conversion per
        ADR-0003 — both to_wire() and the SSE emission path go through here.
        """
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
        """Common fields every capture_* SSE event carries.

        Internal field name (`self.job_id`) is unchanged for now — Task 13
        removes the legacy singleton entirely. The wire field is `item_id`
        per spec §3.4.
        """
        return {
            "item_id": self.job_id,
            "code": self.code,
            "date": self.date,
            "phase": self.phase,
        }

    def to_wire(self) -> CaptureJob:
        return CaptureJob(
            item_id=self.job_id,
            code=self.code,
            date=self.date,
            phase=self.phase,                # type: ignore[arg-type]
            force_retry=False,                # old singleton path never set this
            pause_origin=False,
            enqueued_at_ms=self.started_at_ms or 0,
            started_at_ms=self.started_at_ms or None,
            progress=self.to_progress(),
            result=self.result,
            error=self.error,
        )

    @property
    def is_terminal(self) -> bool:
        return self.phase in ("done", "failed", "cancelled")


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
_latest: CaptureJobState | None = None

# --- Queue state singletons (Plan B) ---------------------------------------
# These coexist with the legacy `_latest` until Task 13 removes the old
# singleton. New code paths only ever touch the queue surface.

_queue: collections.deque[Any] = collections.deque()    # deque[QueueItemState]
_active: dict[str, Any] = {}                            # item_id → QueueItemState
_done: list[Any] = []                                   # terminal items, cleared by DELETE /done
_inflight_paths: set[tuple[str, str]] = set()           # (code, date) — see spec §11 Q15 Layer 2
_queue_paused: bool = False
_max_concurrent: int = int(os.environ.get("HOGA_MAX_CONCURRENT", "3"))
_wakeup: asyncio.Event | None = None                    # lazily constructed when the first worker starts


def get_latest() -> CaptureJobState | None:
    return _latest


def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears all module singletons."""
    global _latest, _queue_paused, _wakeup  # noqa: PLW0603 — intentional test-only reset of module singletons
    _latest = None
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


def cancel_latest_on_shutdown() -> None:
    """Best-effort cancel called from app lifespan teardown. Raw pages on disk
    are preserved for the user to Resume; the asyncio task is abandoned (the
    server is going down anyway). See spec §9 'server restart loses state'.
    """
    if _latest is not None and not _latest.is_terminal and _latest.cancel_token is not None:
        _latest.cancel_token.cancel()


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


def _apply_progress(state: CaptureJobState, evt: ProgressEvent) -> None:
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
    state.elapsed_ms = int(time.time() * 1000) - state.started_at_ms
    # Estimate: % of Data Window covered. HogaMs arithmetic returns int
    # (NewType subtraction is identity), so span/offset are plain ints.
    span = CHART_FINAL_TIME_MS - DATA_WINDOW_START_MS
    offset = max(0, evt.frontier - DATA_WINDOW_START_MS)
    state.estimate_pct = min(98, max(0, int(100 * offset / span)))
    progress = state.to_progress()
    assert progress is not None  # pages_done > 0 since on_progress just fired
    _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))


def _make_progress_callback(state: CaptureJobState):
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


async def _run_capture_job(
    *,
    state: CaptureJobState,
    client: Any,
    data_dir: Path,
) -> None:
    """Runs collector (+ optional parse) on the asyncio event loop.

    Sets state.started_at_ms just before the collector entry per spec §4.1
    'started_at_ms definition'. collect_stock_date is sync; we run it in a
    thread executor so the event loop stays free for SSE / other requests.
    """
    # cancel_token is created in the POST handler so a cancel arriving before
    # this task ticks for the first time still finds a real token. Only create
    # one here if state arrived without (defensive — covers test-only entry
    # points that bypass the route).
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    _publish_event(CapturePhaseEvent(**state.event_header()))

    loop = asyncio.get_running_loop()

    try:
        result = await loop.run_in_executor(
            None,
            lambda: collect_stock_date(
                client=client,
                code=state.code,
                date=state.date,
                data_dir=data_dir,
                rate_limit_s=0.0 if state.options.get("_fast_test", False) else 0.2,
                resume=bool(state.options.get("resume", False)),
                on_progress=_make_progress_callback(state),
                cancel_token=state.cancel_token,
            ),
        )
        parsed = False
        if not state.options.get("capture_only", False):
            state.phase = "parsing"
            _publish_event(CapturePhaseEvent(**state.event_header()))
            await loop.run_in_executor(
                None,
                lambda: parse_stock_date(
                    code=state.code,
                    date=state.date,
                    data_dir=data_dir,
                    lenient=False,
                ),
            )
            parsed = True

        state.result = CaptureResult(
            pages_written=result.pages_written,
            unique_events=result.unique_events,
            raw_dir=str(result.raw_dir),
            parsed=parsed,
        )
        state.phase = "done"
    except CaptureCancelled:
        state.phase = "cancelled"
    except Exception as exc:  # noqa: BLE001 — terminal failure path
        # Intentionally NOT catching BaseException: asyncio.CancelledError must
        # propagate so graceful shutdown can unwind cleanly. KeyboardInterrupt
        # / SystemExit aren't expected from the executor thread but if they
        # arrive we want them to bubble too.
        code = _exception_to_error_code(exc)
        state.error = CaptureError(
            code=code or "internal_error",
            message=str(exc),
            at_page=state.pages_done or None,
        )
        state.phase = "failed"

    _publish_event(CaptureFinishedEvent(
        **state.event_header(),
        result=state.result,
        error=state.error,
    ))


KST = timezone(timedelta(hours=9))


class StartCaptureRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    date: str = Field(pattern=r"^\d{8}$")
    resume: bool = False
    capture_only: bool = False


def _make_job_id(code: str, date: str) -> str:
    now = datetime.now(tz=KST).strftime("%Y%m%dT%H%M%S")
    return f"{now}-{code}-{date}"


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


async def _run_item(state: QueueItemState) -> None:
    """Default item-running path. Tasks 5+ replace this with the deciding/
    capturing/parsing pipeline. Stub for Task 4: just mark done immediately
    so the pump infrastructure can be tested in isolation."""
    state.phase = "done"


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
                state.phase = "deciding"
                _active[state.item_id] = state
                wait = None
        if wait is not None:
            await wait
            async with _lock:
                if _wakeup is not None:
                    _wakeup.clear()
            continue
        assert state is not None
        # Outside the lock: notify deciding, run, finalize.
        await _publish_phase(state)
        try:
            await _run_item(state)
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
    lifespan calls this exactly once."""
    global _wakeup  # noqa: PLW0603
    if _wakeup is None:
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


def build_router(
    *,
    data_dir: Path,
    client_factory: Callable[[], object],
) -> APIRouter:
    """Build the captures router.

    `client_factory()` returns a fresh HogaplayClientProto. In production this
    yields a real HogaplayClient; tests inject a fake.
    """
    router = APIRouter(prefix="/api/captures", tags=["captures"])

    @router.post("", status_code=201)
    async def start_capture(req: StartCaptureRequest) -> CaptureJob:
        global _latest  # noqa: PLW0603 — module singleton write under _lock
        async with _lock:
            if _latest is not None and not _latest.is_terminal:
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "already_running",
                        "latest": _latest.to_wire().model_dump(),
                    },
                )
            # Backend re-validation of today-too-early policy (defense in depth).
            now_kst = datetime.now(tz=KST)
            if is_today_too_early(req.date, now_kst):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "today_too_early",
                        "message": (
                            f"date={req.date} is today (KST) and now.hour={now_kst.hour} < 18."
                        ),
                    },
                )

            options: dict[str, Any] = {
                "resume": req.resume,
                "capture_only": req.capture_only,
            }
            # In test mode (same flag that swaps in FakeHogaplayClient),
            # also drop the 0.2s rate-limit so the ~1267 empty-page
            # termination iterations don't dominate run time.
            if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1":
                options["_fast_test"] = True
            # Build the client FIRST. If it raises (missing/invalid cookie,
            # config error), the request fails cleanly without polluting the
            # _latest singleton — otherwise the failed state would stick
            # around as a non-terminal "capturing" job that every subsequent
            # POST sees as 409 already_running.
            try:
                client = client_factory()
            except CookieMissingError as exc:
                raise HTTPException(
                    status_code=400,
                    detail={"code": "cookie_missing", "message": str(exc)},
                ) from exc

            state = CaptureJobState(
                job_id=_make_job_id(req.code, req.date),
                code=req.code,
                date=req.date,
                options=options,
            )
            # Create the cancel token here, BEFORE the task is scheduled, so a
            # cancel POST arriving in the micro-window between this return and
            # _run_capture_job's first tick still finds a real token. Otherwise
            # the cancel handler would no-op silently and the user would see
            # 202 while the capture continued.
            state.cancel_token = CancelToken()
            _latest = state
            state.task = asyncio.create_task(
                _run_capture_job(state=state, client=client, data_dir=data_dir)
            )
            return state.to_wire()

    @router.get("/latest")
    async def get_latest_route() -> CaptureJob | None:
        if _latest is None:
            return None
        return _latest.to_wire()

    @router.post("/latest/cancel", status_code=202)
    async def cancel_latest() -> dict:
        if _latest is None or _latest.is_terminal:
            raise HTTPException(
                status_code=409,
                detail={"code": "not_running",
                        "message": "no running capture to cancel"},
            )
        if _latest.cancel_token is not None:
            _latest.cancel_token.cancel()
        return {"status": "cancel_signal_delivered", "job_id": _latest.job_id}

    @router.delete("/latest", status_code=204)
    async def dismiss_latest() -> None:
        global _latest  # noqa: PLW0603 — module singleton write
        if _latest is not None and not _latest.is_terminal:
            raise HTTPException(
                status_code=409,
                detail={"code": "still_running",
                        "message": "cancel the running capture before dismissing"},
            )
        _latest = None

    return router
