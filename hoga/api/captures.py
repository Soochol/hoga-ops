"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import asyncio
import collections
import datetime as dt
import logging
import os
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

import hoga
from hoga.api.calendar import KrxUnavailableError
from hoga.api.captures_persistence import load_manifest, manifest_path, save_manifest
from hoga.api.eligibility import decide_capture, find_ineligible_dates
from hoga.api.error_codes import CaptureErrorCode, UpstreamCode
from hoga.api.models import (
    BlockedItem,
    CaptureDismissedEvent,
    CaptureError,
    CaptureFinishedEvent,
    CapturePhase,
    CapturePhaseEvent,
    CaptureProgress,
    CaptureProgressEvent,
    CaptureQueuedEvent,
    CaptureQueuePausedEvent,
    CaptureQueueResumedEvent,
    CaptureResult,
    CaptureTimingEvent,
    EnqueueDedupedRow,
    EnqueueRequest,
    EnqueueResponse,
    QueueManifest,
    QueueManifestItem,
    QueueSnapshot,
    RetryRequest,
    RetryResponse,
    RetrySkippedRow,
    SkipReason,
    TimingEnv,
    ViolationModel,
)
from hoga.api import watchlist
from hoga.api.timeenc import HogaMs, hhmmssms_to_unix_ms
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.timing import CaptureTimingCollector
from hoga.collector.timing_writer import write_timing_report
from hoga.collector.orchestrator import (
    CHART_FINAL_TIME_MS,
    DATA_WINDOW_START_MS,
    DEFAULT_PAGE_STEP_MS,
    DEFAULT_RATE_LIMIT_S,
    CancelToken,
    CaptureCancelled,
    ProgressEvent,
    TodayTooEarlyRefused,
    UpstreamNoDataError,
    collect_stock_date,
)
from hoga.util.git_sha import get_git_sha
from hoga.config import CookieMissingError
from hoga.parser import parse_stock_date
from hoga.tables.snapshots import SnapshotValidationError
from hoga.tables.trades import TradeValidationError

# Fail fast if someone runs uvicorn multi-worker — see spec §4.4.
# The _latest singleton and asyncio.Lock are per-process; multi-worker would
# silently break (parallel captures, cookie 429s, SSE blind spots).
if int(os.environ.get("WEB_CONCURRENCY", "1")) > 1:
    raise RuntimeError(
        "hoga-ops captures require a single uvicorn worker. "
        "Found WEB_CONCURRENCY > 1. Use `hoga serve` or pass --workers 1."
    )


def _validation_error_to_warning(exc: BaseException) -> ViolationModel:
    """Build a wire warning from the strict-mode validation error that
    triggered the lenient fallback. Carrying the exception message verbatim
    keeps the surfaced detail (e.g. ``cum_vol decreased at ts_ms=...``)
    identical to what the operator saw in the old `failed` row, so they can
    correlate with any previously captured logs / screenshots.

    Scoped intentionally: meta.json carries every archival-only invariant
    (e.g. ``series.candles_ts_monotonic``) regardless of strict outcome, so
    reading the whole list would leak warnings unrelated to this capture's
    fallback. The exception identifies the single invariant the strict path
    objected to — that is the truthful, minimal warning to surface.
    """
    invariant_id = (
        "series.cum_vol_monotonic" if isinstance(exc, TradeValidationError)
        else "series.snapshots_ladder_ordered" if isinstance(exc, SnapshotValidationError)
        else "series.unknown"
    )
    return ViolationModel(
        invariant_id=invariant_id,
        severity="warn",  # captures-UI semantics: parse completed via fallback
        message=str(exc),
        ctx={},
    )


def _exception_to_error_code(exc: BaseException) -> CaptureErrorCode | UpstreamCode | None:
    """Map a Python exception class to the API `code` field.

    Returns None for CaptureCancelled — that produces a `cancelled` phase,
    not a `failed` one.
    """
    if isinstance(exc, TodayTooEarlyRefused):
        return CaptureErrorCode.TODAY_TOO_EARLY
    if isinstance(exc, CookieMissingError):
        return UpstreamCode.COOKIE_MISSING
    if isinstance(exc, CookieExpiredError):
        return UpstreamCode.COOKIE_EXPIRED
    if isinstance(exc, HogaplayHTTPError):
        return UpstreamCode.HOGAPLAY_HTTP_ERROR
    if isinstance(exc, CaptureCancelled):
        return None
    return CaptureErrorCode.INTERNAL_ERROR


@dataclass
class QueueItemState:
    """Mutable server-side state for one queue item. Not a Wire Model."""
    item_id: str
    code: str
    date: str
    force_retry: bool
    enqueued_at_ms: int
    phase: CapturePhase = "queued"
    pause_origin: bool = False
    started_at_ms: int | None = None
    pages_done: int = 0
    events_seen: int = 0
    frontier: HogaMs = HogaMs(0)  # collector encoding (HHMMSSmmm); see ADR-0003
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    skip_reason: SkipReason | None = None
    cancel_token: Any = None
    attempt: int = 1
    # Populated when the strict-mode parse raised TradeValidationError /
    # SnapshotValidationError and the lenient-mode retry recorded violations
    # in meta.json. Stays None on clean parses so the wire payload omits it.
    warnings: list[ViolationModel] | None = None

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
            phase=self.phase,
            force_retry=self.force_retry,
            pause_origin=self.pause_origin,
            enqueued_at_ms=self.enqueued_at_ms,
            started_at_ms=self.started_at_ms,
            progress=self.to_progress(),
            result=self.result,
            error=self.error,
            skip_reason=self.skip_reason,
            attempt=self.attempt,
            warnings=self.warnings,
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
_fail_streaks: dict[str, int] = {}                      # ADR-0042: per-(Code, Stock-Date) consecutive failed+skipped counter
_max_concurrent: int = int(os.environ.get("HOGA_MAX_CONCURRENT", "3"))


def _timing_enabled() -> bool:
    """Read HOGA_CAPTURE_TIMING at call time. Default ON; only explicit
    falsy values disable. Empty string is treated as 'unset' (= default ON)."""
    raw = os.environ.get("HOGA_CAPTURE_TIMING", "1").strip().lower()
    return raw not in ("0", "false", "no", "off")
_wakeup: asyncio.Event | None = None                    # lazily constructed when the first worker starts
_workers: list[asyncio.Task] = []                       # populated by app lifespan; stopped on shutdown

# Production dependencies — set by build_router() at startup.
# Tests bypass build_router() by writing directly: `captures._data_dir = tmp_path`.
# That's the deliberate DI surface: the module attribute IS the seam, no
# additional sentinel + resolver indirection.
_data_dir: Path | None = None
_client_factory: Callable[[], object] | None = None


def _require_data_dir() -> Path:
    assert _data_dir is not None, "captures._data_dir not initialized; call build_router() or set in test fixture"
    return _data_dir


def _require_client_factory() -> Callable[[], object]:
    assert _client_factory is not None, "captures._client_factory not initialized; call build_router() or set in test fixture"
    return _client_factory


def _record_no_upstream_data(data_dir: Path, code: str, date: str) -> None:
    """Write the .no_upstream_data sentinel and remove zero-byte
    pre-collect artifacts so the raw_dir is in canonical form for
    check_disk_state (see ADR-0021).

    Cleans up `info.tsv`, `chart.tsv`, `_progress.json` from raw_dir
    (any of which may have been touched before the empty-info detection
    fired) and writes the sentinel. Does NOT touch parquet_dir — if a
    stale meta.json from a prior successful capture exists, it is
    shadowed by check_disk_state's sentinel-first ordering, not deleted
    here. force_retry deletes the sentinel before re-running
    collect_stock_date.
    """
    raw_dir = data_dir / "raw" / date / code
    raw_dir.mkdir(parents=True, exist_ok=True)
    for stale in ("info.tsv", "chart.tsv", "_progress.json"):
        (raw_dir / stale).unlink(missing_ok=True)
    (raw_dir / ".no_upstream_data").touch()


def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears all module singletons + the
    on-disk manifest (so per-test state never leaks)."""
    global _queue_paused, _wakeup  # noqa: PLW0603 — intentional test-only reset of module singletons
    _queue.clear()
    _active.clear()
    _done.clear()
    _inflight_paths.clear()
    _fail_streaks.clear()  # ADR-0042 — keep test isolation for the new counter
    _queue_paused = False
    # _wakeup is an asyncio.Event bound to an event loop — pytest-asyncio
    # creates a fresh loop per test, so we must drop the stale Event or the
    # next test gets "bound to a different event loop" errors. Workers
    # construct one lazily in start_workers().
    _wakeup = None
    if _data_dir is not None:
        manifest_path(_data_dir).unlink(missing_ok=True)


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


# --- Queue manifest persistence (ADR-0019) --------------------------------

def _items_in_restore_order() -> Iterator[QueueItemState]:
    """Yield queue items in the order they should be restored after a crash.

    Active items first, then queued items, then pause_origin-cancelled
    items from _done. The invariant (spec §4.5, ADR-0019 §5): on restart,
    items that were previously running get re-queued before strictly-queued
    ones, so they pick up resume=True via decide_capture sooner.

    pause_origin items in _done are the cookie-pause recovery list — they
    must survive restart so the user's eventual ``POST /queue/resume`` can
    re-enqueue them. The "_done is volatile" rule (ADR-0019 §3 decision #6)
    has this narrow carve-out; without it, a crash between cookie-expire
    and resume would silently drop the paused work. ADR-0019 §"Consequences"
    documents the gap this closes.

    Naming the iterator concentrates the ordering + selection decision in
    one place — both _persist_queue_locked (write side) and
    _restore_queue_from_manifest (read side) rely on it implicitly.
    """
    yield from _active.values()
    yield from _queue
    for s in _done:
        if s.pause_origin and s.phase == "cancelled":
            yield s


def _apply_terminal_to_streaks(
    fail_streaks: dict[str, int], code: str, date: str, phase: str,
) -> None:
    """Mutate ``fail_streaks`` in place per ADR-0042:

    - ``phase == "done"``                → counter reset (key removed for tidiness)
    - ``phase in {"failed", "skipped"}`` → counter += 1
    - ``phase == "cancelled"``           → no change (user-initiated; external-call status unknown)
    - any other phase                    → ValueError (programmer bug; phase enum is closed)

    Caller is responsible for persisting after mutation.
    """
    from hoga.api.fail_streak import streak_key
    key = streak_key(code, date)
    if phase == "done":
        fail_streaks.pop(key, None)
    elif phase in ("failed", "skipped"):
        fail_streaks[key] = fail_streaks.get(key, 0) + 1
    elif phase == "cancelled":
        pass
    else:
        raise ValueError(f"unexpected terminal phase: {phase!r}")


def apply_terminal_to_manifest(
    manifest: QueueManifest, code: str, date: str, phase: str,
) -> None:
    """ADR-0042 worker-terminal hook (pure function on a QueueManifest).

    Thin wrapper around :func:`_apply_terminal_to_streaks` that operates on
    ``manifest.fail_streaks``. Tests use this signature directly; the in-process
    call site mutates the module-global :data:`_fail_streaks` via the inner
    helper for the same logic.
    """
    _apply_terminal_to_streaks(manifest.fail_streaks, code, date, phase)


def _persist_queue_locked() -> None:
    """Snapshot _active + _queue + _queue_paused + _fail_streaks to the
    on-disk manifest.

    INVARIANT: caller holds ``_lock``. Called from every mutation site that
    touches _queue or _active or _fail_streaks. _done is intentionally
    excluded (volatile — cleared by DELETE /done; see ADR-0019).
    """
    if _data_dir is None:
        return  # test fixture without data_dir wired — no lock check needed
    assert _lock.locked(), "must hold _lock — see ADR-0019"
    items = [
        QueueManifestItem(
            item_id=s.item_id,
            code=s.code,
            date=s.date,
            force_retry=s.force_retry,
            enqueued_at_ms=s.enqueued_at_ms,
            pause_origin=s.pause_origin,
            attempt=s.attempt,
        )
        for s in _items_in_restore_order()
    ]
    save_manifest(
        _data_dir,
        QueueManifest(paused=_queue_paused, items=items, fail_streaks=dict(_fail_streaks)),
    )


def _restore_queue_from_manifest(data_dir: Path) -> None:
    """Read ``<data_dir>/.queue.json`` and rehydrate ``_queue`` + ``_done``.

    Called once at lifespan startup BEFORE ``start_workers()``.

    Routing rule (ADR-0019):
    - ``pause_origin=True`` items → ``_done`` with ``phase="cancelled"``,
      matching the in-process post-cookie-pause shape so the user's eventual
      ``POST /queue/resume`` finds them via ``resume_queue``.
    - Everything else → ``_queue`` with ``phase="queued"``; the worker's
      deciding step then routes via ``decide_capture`` based on disk state
      (CLIENT_INCOMPLETE → resume=True, NONE → fresh, COMPLETE → skipped).

    Crash-timing irrelevance: ``_handle_cookie_expired`` marks active items
    with ``pause_origin=True`` and signals cancel. Whether the worker has
    observed the cancel yet (item still in ``_active``) or already finalized
    (item in ``_done``), the persisted manifest carries ``pause_origin=True``
    on the same Stock-Date — both crash points restore to the same recovered
    shape.
    """
    global _queue_paused, _fail_streaks  # noqa: PLW0603 — startup-only module write
    manifest = load_manifest(data_dir)
    if manifest is None:
        return
    _queue_paused = manifest.paused
    _fail_streaks = dict(manifest.fail_streaks)  # ADR-0042 — restore counter across restart
    for item in manifest.items:
        state = QueueItemState(
            item_id=item.item_id,
            code=item.code,
            date=item.date,
            force_retry=item.force_retry,
            enqueued_at_ms=item.enqueued_at_ms,
            pause_origin=item.pause_origin,
            phase="cancelled" if item.pause_origin else "queued",
            attempt=item.attempt,
        )
        if item.pause_origin:
            _done.append(state)
        else:
            _queue.append(state)
    logging.getLogger(__name__).info(
        "restored queue manifest: %d items, paused=%s",
        len(manifest.items), manifest.paused,
    )


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

    Serialization errors (e.g., a future event schema with a non-JSON-
    serializable field) are caught and logged — without this guard the
    exception would propagate into the route handler / consumer task and
    silently break ALL downstream SSE events. The UI would freeze
    visibly; the cause would only surface in stack-trace logs the user
    might never read. Trade: one missed event is acceptable; a cascading
    SSE outage is not.

    No-op when bus/loop aren't wired (test mode).
    """
    if _bus is None or _loop is None:
        return
    try:
        payload = event.model_dump(mode="json")
    except Exception:  # noqa: BLE001 — keep SSE channel alive on serializer bugs
        logging.getLogger(__name__).exception(
            "_publish_event: failed to serialize %s; event dropped",
            type(event).__name__,
        )
        return
    _loop.call_soon_threadsafe(_bus.publish, payload)


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


async def _run_capture_and_parse(
    state: QueueItemState,
    *,
    resume: bool,
    collector: CaptureTimingCollector | None = None,
) -> None:
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
            await _run_capture_inner(state, resume=resume, collector=collector)
            return
        except HogaplayHTTPError as exc:
            if exc.status_code != 429 or delay is None:
                raise
            last_exc = exc
            if collector is not None:
                collector.record_error("http_429")
                with collector.phase("backoff"):
                    cancelled = await _cancel_aware_sleep(state, delay)
            else:
                cancelled = await _cancel_aware_sleep(state, delay)
            if cancelled:
                raise CaptureCancelled() from exc
    if last_exc is not None:
        raise last_exc


async def _run_capture_inner(
    state: QueueItemState,
    *,
    resume: bool,
    collector: CaptureTimingCollector | None = None,
) -> None:
    """Run the collector then the parser. Cookie-missing/expired rejection
    happens via the cookie-pause path in the worker loop. Task 11's
    ``_run_capture_and_parse`` wrapper provides 429 backoff around this.

    ``UpstreamNoDataError`` (collector raises on empty info.php — ADR-0021)
    is caught here and converted to a normal ``skipped`` return: writes the
    ``.no_upstream_data`` sentinel via ``_record_no_upstream_data``, sets
    ``state.phase = "skipped"`` and ``state.skip_reason = "no_upstream_data"``,
    and returns. The outer worker loop's generic ``except Exception`` never
    sees this, so the item is not classified as ``failed``.
    """
    if state.cancel_token is None:
        state.cancel_token = CancelToken()
    data_dir = _require_data_dir()
    client = _require_client_factory()()

    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    await _publish_phase(state)

    loop = asyncio.get_running_loop()
    try:
        result = await loop.run_in_executor(
            None,
            lambda: collect_stock_date(
                client=client,
                code=state.code,
                date=state.date,
                data_dir=data_dir,
                # Production rate from ADR-0017. HOGA_ENABLE_TEST_ENDPOINTS=1 skips the sleep
                # entirely for tests; otherwise we use the same default as collect_stock_date.
                rate_limit_s=0.0 if os.environ.get("HOGA_ENABLE_TEST_ENDPOINTS") == "1" else DEFAULT_RATE_LIMIT_S,
                resume=resume,
                on_progress=_make_progress_callback(state),
                cancel_token=state.cancel_token,
                collector=collector,
            ),
        )
    except UpstreamNoDataError:
        # ADR-0021: convert empty-info signal into a normal skipped return.
        # Outer worker loop's generic except handler never sees this, so
        # state.phase does not flip to 'failed'.
        _record_no_upstream_data(data_dir, state.code, state.date)
        state.phase = "skipped"
        state.skip_reason = "no_upstream_data"
        state.estimate_pct = 100
        progress = state.to_progress()
        if progress is not None:
            _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))
        return

    state.phase = "parsing"
    await _publish_phase(state)
    # ADR-0020 strict-first/lenient-fallback: strict mode is the canary that
    # catches parser-side bugs (page sort, dedup, tie-break — see 65c0a2f).
    # But upstream hogaplay occasionally emits a single cum_vol rebase or
    # out-of-ladder orderbook snapshot, and rejecting a 10-minute capture over
    # one anomaly is the wrong trade. On a known invariant failure we retry
    # with lenient=True, then surface the violations from meta.json as
    # warnings (phase stays 'done'). Other parser failures (file I/O, schema
    # drift, unknown event types) still propagate to the worker loop's
    # exception handler and flip phase to 'failed' as before.
    try:
        if collector is not None:
            with collector.phase("parse"):
                await loop.run_in_executor(
                    None,
                    lambda: parse_stock_date(
                        code=state.code, date=state.date, data_dir=data_dir, lenient=False,
                    ),
                )
        else:
            await loop.run_in_executor(
                None,
                lambda: parse_stock_date(
                    code=state.code, date=state.date, data_dir=data_dir, lenient=False,
                ),
            )
    except (TradeValidationError, SnapshotValidationError) as exc:
        await loop.run_in_executor(
            None,
            lambda: parse_stock_date(
                code=state.code, date=state.date, data_dir=data_dir, lenient=True,
            ),
        )
        state.warnings = [_validation_error_to_warning(exc)]

    state.result = CaptureResult(
        pages_written=result.pages_written,
        unique_events=result.unique_events,
        raw_dir=str(result.raw_dir),
        parsed=True,
        abort_reason=result.abort_reason,
    )
    state.phase = "done"
    # Spec §5.5: estimate_pct is clipped to 0..98 during capture; 100 is reserved
    # for the terminal `done` state. Bump it here and emit a final progress event
    # so the UI fills the bar — without this, the row shows "done" alongside 98%.
    state.estimate_pct = 100
    progress = state.to_progress()
    if progress is not None:
        _publish_event(CaptureProgressEvent(**state.event_header(), progress=progress))


async def _run_item(state: QueueItemState) -> None:
    """Full pipeline: deciding → (skipped | capturing → parsing → done).

    Disk-state branches (see spec §5.2 + §11 Q16, ADR-0021 for NO_UPSTREAM_DATA):
    - COMPLETE → skipped/already_complete
    - NO_UPSTREAM_DATA + not force_retry → skipped/no_upstream_data
    - NO_UPSTREAM_DATA + force_retry → sentinel deleted, fresh capture (resume=False)
    - SOURCE_PARTIAL + not force_retry → skipped/source_partial
    - SOURCE_PARTIAL + force_retry → fresh capture (resume=False)
    - INVALID → fresh capture (resume=False)
    - CLIENT_INCOMPLETE → resume=True (continue from existing pages)
    - NONE → fresh capture (resume=False)
    """
    collector: CaptureTimingCollector | None = (
        CaptureTimingCollector(state.code, state.date) if _timing_enabled() else None
    )
    # TODO(timing): plumb effective rate, see plan §13 step 4.
    # _run_capture_inner does not currently surface the rate it passed to
    # collect_stock_date back to this scope; recording the module default
    # is accurate for the common case (no environment-driven override).
    effective_rate_s: float = DEFAULT_RATE_LIMIT_S
    data_dir = _require_data_dir()
    decision = decide_capture(
        data_dir=data_dir,
        code=state.code,
        date=state.date,
        force_retry=state.force_retry,
    )
    if decision.skip_reason is not None:
        state.phase = "skipped"
        state.skip_reason = decision.skip_reason
        return
    try:
        try:
            await _run_capture_and_parse(state, resume=decision.resume, collector=collector)
        except CookieExpiredError:
            # Record before re-raising so the error lands in the collector's
            # ``error_counts`` / page errors. The worker loop's existing
            # ``_handle_cookie_expired(state)`` handler then pauses the queue.
            # No ``cookie_pause`` phase wrap here: the failing item is terminal
            # and never sleeps awaiting a resume (see plan-review eng B2).
            if collector is not None:
                collector.record_error("cookie_expired")
            raise
    finally:
        # Best-effort timing emit. Runs on success, failure, AND cancellation
        # — the finally guarantees we always persist what we measured. Any
        # exception in this block is swallowed and logged so a timing-writer
        # bug can never break the capture pipeline itself.
        if collector is not None:
            try:
                env = TimingEnv(
                    rate_limit_s=effective_rate_s,
                    max_concurrent=_max_concurrent,
                    page_step_ms_initial=DEFAULT_PAGE_STEP_MS,
                    hoga_version=hoga.__version__,
                    git_sha=get_git_sha(),
                )
                report = collector.to_report(env=env)
                # JSON first so any consumer reacting to the SSE event can
                # immediately open the file and see a complete report.
                write_timing_report(_require_data_dir(), report)
                # Then SSE summary (no per-page detail on the wire).
                _publish_event(
                    CaptureTimingEvent(
                        id=f"{state.code}:{state.date}",
                        summary=report.summary,
                    )
                )
            except Exception as exc:  # noqa: BLE001 — never break the capture pipeline
                logging.getLogger(__name__).warning(
                    "capture_timing emit failed for %s/%s: %r",
                    state.code,
                    state.date,
                    exc,
                )


async def _finalize_item(state: QueueItemState) -> None:
    """Move state into _done, publish finished, wake other workers, emit
    drained if applicable."""
    from hoga.api.models import CaptureQueueDrainedEvent
    async with _lock:
        _active.pop(state.item_id, None)
        _inflight_paths.discard((state.code, state.date))
        _done.append(state)
        # ADR-0042: update fail_streak BEFORE persist so the manifest write
        # carries the new counter value.
        _apply_terminal_to_streaks(_fail_streaks, state.code, state.date, state.phase)
        _persist_queue_locked()  # ADR-0019 + ADR-0042 — item left _active, fail_streak updated
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
        skip_reason=state.skip_reason,
        warnings=state.warnings,
    ))
    # ADR-0034: Watchlist's last_success_date marker advances on successful
    # captures regardless of whether the capture was ad-hoc or scheduled.
    # Gate on the on-disk classification (same predicate the /capture calendar
    # uses) rather than ``state.phase``: phase="done" means "worker returned
    # without exception" and is reachable with abort_reason set (e.g.
    # stagnation_abort) or with lenient-fallback invariant violations,
    # neither of which produce a COMPLETE Stock-Date on disk. Reading the
    # disk state here ensures the marker can never disagree with the
    # calendar UI by construction.
    if state.phase == "done":
        try:
            from hoga.api.disk_state import DiskState, check_disk_state
            data_dir = _require_data_dir()
            if (check_disk_state(data_dir, state.code, state.date).state
                    == DiskState.COMPLETE):
                await watchlist.bump_last_success(
                    data_dir, code=state.code, date=state.date,
                )
        except Exception:  # noqa: BLE001 — never let watchlist break the queue
            logging.getLogger(__name__).exception(
                "watchlist bump_last_success failed for %s/%s",
                state.code, state.date,
            )


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
        _persist_queue_locked()  # ADR-0019 — paused flag flipped
    _publish_event(CaptureQueuePausedEvent(
        reason="cookie_expired",
        message="Cookie expired — pool paused. Refresh .cookie and POST /api/captures/queue/resume.",
    ))


async def resume_queue() -> None:
    """Re-queue pause_origin items from _done to the FRONT (appendleft).
    Clears _queue_paused and wakes workers.

    ``attempt`` is INTENTIONALLY not incremented on resume: pause/resume
    is one logical capture attempt that was interrupted (cookie expired,
    operator paused for diagnostics) — not a user-driven retry. The
    ×N attempt badge in the UI tracks user-initiated retries via
    ADR-0031, not infrastructure-driven pauses. If a future code path
    needs "resume counts as +1 attempt" semantics, it must add a
    separate counter rather than reusing ``attempt``.
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
        _persist_queue_locked()  # ADR-0019 — queue + paused both changed
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
        _persist_queue_locked()  # ADR-0019
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
                    _persist_queue_locked()  # ADR-0019 — queued→active transition
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
                code=UpstreamCode.COOKIE_EXPIRED,
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
                code=_exception_to_error_code(exc) or CaptureErrorCode.INTERNAL_ERROR,
                message=str(exc),
                at_page=state.pages_done or None,
            )
            state.phase = "failed"
        await _finalize_item(state)


def start_workers(n: int | None = None) -> list[asyncio.Task]:
    """Spin up the worker pool WITHOUT restoring the manifest.

    Production callers use :func:`start_capture_pool` instead, which
    bundles the ADR-0019 ordering invariant (restore-before-spawn).
    Tests use this directly when they want bare worker control without
    touching the on-disk manifest.

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


def start_capture_pool(data_dir: Path) -> list[asyncio.Task]:
    """Production boot entry: restore the queue manifest from disk (if any),
    then spawn the worker pool.

    Bundles the ADR-0019 ordering invariant — restore-before-spawn — into a
    single call so future readers (and new callers like a test harness) can't
    accidentally start workers against an empty queue when the disk holds
    items to recover. ``app.py`` lifespan uses this; tests that exercise the
    full boot path should too.
    """
    _restore_queue_from_manifest(data_dir)
    return start_workers()


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


# `_now_kst` is re-exported from the canonical Clock owner (orchestrator)
# so the today_too_early policy + item-id stamping use the same wall-clock
# source. Tests still patch `hoga.api.captures._now_kst` because the name
# is bound at this module's scope (standard Python patching convention).
from hoga.collector.orchestrator import now_kst as _now_kst  # noqa: E402


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


def _publish_queue_mutations(
    *,
    dismissed_ids: list[str] | None = None,
    enqueued: list["QueueItemState"] | None = None,
) -> None:
    """Emit the standard SSE sequence for a queue mutation: ``CaptureDismissedEvent``
    first (so frontends remove the old rows), then ``CaptureQueuedEvent`` (so they
    add the new ones). Either argument may be omitted or empty — empty events are
    skipped.

    All three mutation sites that move rows out of ``_done`` and/or surface fresh
    rows in ``_queue`` route through here: explicit Retry (ADR-0031), implicit
    Retry via ``addItems`` (ADR-0033), and ``dismissDone`` (dismissal only).
    Concentrating the "dismissed-before-queued" ordering invariant here means
    new mutation sites can't accidentally reverse it.

    Caller MUST have released ``_lock`` first — the helper publishes synchronously.
    """
    if dismissed_ids:
        _publish_event(CaptureDismissedEvent(item_ids=dismissed_ids))
    if enqueued:
        _publish_event(CaptureQueuedEvent(items=[s.to_wire() for s in enqueued]))


@dataclass
class _RetryResult:
    """Internal Retry outcome — what the HTTP handler turns into RetryResponse.

    `skipped` is already-typed `RetrySkippedRow`s (not raw dicts) so the route
    handler is a one-line pass-through and a future skip-reason rename is caught
    at type-check time, not at request time.
    """
    enqueued: list[QueueItemState]
    skipped: list[RetrySkippedRow]
    dismissed_item_ids: list[str]           # original ids removed from _done


async def _retry_items(item_ids: list[str]) -> _RetryResult:
    """Core Retry logic (ADR-0031). Caller holds no lock; we acquire ``_lock``
    inside and publish events after release.

    For each item_id (preserving input order):
    - Look up in ``_done``. Missing → skip ``not_found``.
    - Phase must be ``failed`` → otherwise skip ``not_failed``.
    - Apply (code, date) dedupe against ``_queue ∪ _active ∪ _inflight_paths``.
      Hit → skip ``already_running`` / ``already_in_queue``.
    - Remove from ``_done``; enqueue a new ``QueueItemState`` with
      ``attempt = prior + 1`` and the same ``force_retry``.

    Duplicate item_ids in the same batch: the first attempt removes the row
    from ``_done``; the second sees ``not_found``.
    """
    enqueued: list[QueueItemState] = []
    skipped: list[RetrySkippedRow] = []
    dismissed: list[str] = []
    enqueued_at_ms = int(time.time() * 1000)

    async with _lock:
        active_pairs = {(s.code, s.date) for s in _active.values()}
        queue_pairs: set[tuple[str, str]] = {(s.code, s.date) for s in _queue}
        for item_id in item_ids:
            # 1. Find in _done.
            target: QueueItemState | None = None
            target_idx = -1
            for i, s in enumerate(_done):
                if s.item_id == item_id:
                    target = s
                    target_idx = i
                    break
            if target is None:
                skipped.append(RetrySkippedRow(item_id=item_id, reason="not_found"))
                continue
            # 2. Phase guard.
            if target.phase != "failed":
                skipped.append(RetrySkippedRow(item_id=item_id, reason="not_failed"))
                continue
            # 3. Dedupe.
            pair = (target.code, target.date)
            if pair in active_pairs or pair in _inflight_paths:
                skipped.append(RetrySkippedRow(item_id=item_id, reason="already_running"))
                continue
            if pair in queue_pairs:
                skipped.append(RetrySkippedRow(item_id=item_id, reason="already_in_queue"))
                continue
            # 4. Apply: remove old, enqueue new.
            del _done[target_idx]
            dismissed.append(target.item_id)
            new_state = QueueItemState(
                item_id=_make_item_id(target.code, target.date),
                code=target.code,
                date=target.date,
                force_retry=target.force_retry,
                enqueued_at_ms=enqueued_at_ms,
                attempt=target.attempt + 1,
            )
            _queue.append(new_state)
            enqueued.append(new_state)
            queue_pairs.add(pair)   # so a second id targeting same (code, date) is deduped
        if enqueued and _wakeup is not None:
            _wakeup.set()
        _persist_queue_locked()

    _publish_queue_mutations(dismissed_ids=dismissed, enqueued=enqueued)

    return _RetryResult(enqueued=enqueued, skipped=skipped, dismissed_item_ids=dismissed)


async def enqueue_items_core(
    req: EnqueueRequest,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Enqueue items for one (code, range or dates) request.

    Module-level entry point for ADR-0034: the Daily Scheduler (and any other
    in-process caller) invokes this directly instead of self-HTTP-calling the
    router or mutating the queue's internal collections.

    Previously the body of this function lived as an inner closure inside
    ``build_router`` and read ``data_dir`` from the enclosing scope and ``now``
    via ``_now_kst()`` at the top of the handler. Callers now inject them
    explicitly; the route handler is a thin wrapper that passes
    ``_require_data_dir()`` and ``_now_kst()``.

    Q14 guard: any date in the request equal to today_kst with
    now.hour < 17 → 400 today_too_early.
    Q15 Layer 1: per-(code, date) dedupe against
    _queue ∪ _active ∪ _inflight_paths and within-request duplicates.
    Returns the dedupe list in the response.
    """
    # 1. Expand to a flat list of candidate dates.
    if req.dates is not None:
        candidate_dates = list(req.dates)
    elif req.start_date and req.end_date:
        try:
            # Offload the pykrx-backed cold-month fetch to a threadpool
            # so it doesn't block the event loop. Warm cache hit returns
            # in microseconds; cold hit can be 1-3 s of network.
            loop = asyncio.get_running_loop()
            candidate_dates = await loop.run_in_executor(
                None,
                _expand_to_trading_days,
                req.start_date,
                req.end_date,
            )
        except KrxUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": (
                    "KRX trading-day list unavailable. Configure KRX_ID / KRX_PW "
                    "in repo-root .env and try again."
                ),
            }) from e
    else:
        raise HTTPException(status_code=400, detail={
            "code": CaptureErrorCode.MISSING_RANGE,
            "message": "Provide either dates=[...] or start_date+end_date.",
        })

    # 2. Q14 today-too-early guard — delegate to the eligibility seam.
    too_early = find_ineligible_dates(candidate_dates=candidate_dates, now=now)
    if too_early:
        raise HTTPException(status_code=400, detail={
            "code": CaptureErrorCode.TODAY_TOO_EARLY,
            "message": (
                f"Dates {too_early} are today (KST) and now.hour={now.hour} < 17."
            ),
            "dates": too_early,
        })

    # 3. Q15 Layer 1 dedupe: against queue ∪ active ∪ inflight ∪ within-request,
    #    PLUS phase-aware dedupe against _done (ADR-0033).
    enqueued: list[QueueItemState] = []
    deduped_rows: list[EnqueueDedupedRow] = []
    blocked_items: list[BlockedItem] = []
    done_dismissed_ids: list[str] = []
    enqueued_at_ms = int(time.time() * 1000)
    async with _lock:
        # ADR-0042 fail-streak gate. Runs INSIDE the lock (so _fail_streaks is
        # not racing a concurrent _finalize_item) but BEFORE the Q15/ADR-0033
        # dedupe loop, so a blocked (Code, Stock-Date) never reaches Implicit
        # Retry. force_retry=true does NOT bypass this gate — that's the whole
        # point of the cap. blocked pairs are removed from the candidate list.
        from hoga.api.fail_streak import ATTEMPT_CAP, streak_key
        unblocked_dates: list[str] = []
        for date in candidate_dates:
            current = _fail_streaks.get(streak_key(req.code, date), 0)
            if current >= ATTEMPT_CAP:
                blocked_items.append(BlockedItem(
                    code=req.code, date=date, fail_streak=current,
                    reason="fail_streak_exceeded",
                ))
            else:
                unblocked_dates.append(date)
        candidate_dates = unblocked_dates

        active_pairs = {(s.code, s.date) for s in _active.values()}
        queue_pairs = {(s.code, s.date) for s in _queue}
        existing_pairs = set(_inflight_paths) | queue_pairs | active_pairs
        # ADR-0033: phase-aware _done lookup.
        done_index: dict[tuple[str, str], tuple[int, QueueItemState]] = {
            (s.code, s.date): (i, s) for i, s in enumerate(_done)
        }
        done_indices_to_remove: set[int] = set()
        seen_in_request: set[tuple[str, str]] = set()

        for date in candidate_dates:
            pair = (req.code, date)
            # Step 3a: existing dedupe (queue/active/inflight + within-request).
            if pair in existing_pairs or pair in seen_in_request:
                reason = (
                    "already_running" if pair in active_pairs
                    else "already_in_queue"
                )
                deduped_rows.append(EnqueueDedupedRow(
                    code=req.code, date=date, reason=reason,
                ))
                continue

            # Step 3b: ADR-0033 + ADR-0035 _done dedupe — branch by phase + force_retry.
            # done + force_retry → re-enqueue; decide_capture still skips COMPLETE
            # disk state at worker time (eligibility.py), so accidental complete
            # overwrites stay impossible — see ADR-0035 Rationale.
            if pair in done_index:
                idx, old = done_index[pair]
                if (old.phase in ("failed", "cancelled")
                        or (old.phase == "skipped" and req.force_retry)
                        or (old.phase == "done" and req.force_retry)):
                    # Auto re-enqueue: remove old, enqueue new with attempt+1.
                    done_indices_to_remove.add(idx)
                    done_dismissed_ids.append(old.item_id)
                    del done_index[pair]  # within-batch second hit will fall to seen_in_request.
                    seen_in_request.add(pair)
                    new_state = QueueItemState(
                        item_id=_make_item_id(req.code, date),
                        code=req.code,
                        date=date,
                        force_retry=req.force_retry,
                        enqueued_at_ms=enqueued_at_ms,
                        attempt=old.attempt + 1,
                    )
                    _queue.append(new_state)
                    enqueued.append(new_state)
                    continue
                # Dedupe as already_complete / already_skipped.
                reason = (
                    "already_complete" if old.phase == "done"
                    else "already_skipped"  # phase == "skipped" and not force_retry
                )
                deduped_rows.append(EnqueueDedupedRow(
                    code=req.code, date=date, reason=reason,
                ))
                continue

            # Step 3c: fresh enqueue.
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

        # Apply queued _done removals (reverse-sorted to preserve indices).
        for idx in sorted(done_indices_to_remove, reverse=True):
            del _done[idx]

        if enqueued and _wakeup is not None:
            _wakeup.set()
        _persist_queue_locked()  # ADR-0019 — still inside async with _lock

    # 4. Emit dismissed-then-queued via the shared helper (ordering invariant).
    _publish_queue_mutations(dismissed_ids=done_dismissed_ids, enqueued=enqueued)

    return EnqueueResponse(
        enqueued=[s.to_wire() for s in enqueued],
        deduped=deduped_rows,
        blocked=blocked_items,
    )


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
        """Thin wrapper around ``enqueue_items_core`` (ADR-0034)."""
        return await enqueue_items_core(
            req,
            data_dir=_require_data_dir(),
            now=_now_kst(),
        )

    @router.post("/items/retry", status_code=201)
    async def retry_items_route(req: RetryRequest) -> RetryResponse:
        """Retry one or more failed queue items (ADR-0031).

        Each item_id must reference a _done entry whose phase == "failed".
        Other states (`not_found`, `not_failed`, `already_in_queue`,
        `already_running`) return diagnostic rows in `skipped`.
        """
        result = await _retry_items(req.item_ids)
        return RetryResponse(
            enqueued=[s.to_wire() for s in result.enqueued],
            skipped=result.skipped,
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
                    _persist_queue_locked()  # ADR-0019
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
                        "code": CaptureErrorCode.TERMINAL, "phase": s.phase,
                    })
        raise HTTPException(status_code=404, detail={"code": CaptureErrorCode.NOT_FOUND})

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
            ids = [s.item_id for s in _done]
            _done.clear()
        _publish_queue_mutations(dismissed_ids=ids)

    return router
