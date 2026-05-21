"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import asyncio
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
    CaptureJob,
    CaptureProgress,
    CaptureResult,
)
from hoga.api.timeenc import hhmmssms_to_unix_ms
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import (
    CHART_FINAL_TIME_MS,
    DATA_WINDOW_START_MS,
    CancelToken,
    CaptureCancelled,
    PartialCaptureRefused,
    ProgressEvent,
    _is_partial_capture,
    collect_stock_date,
)
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
    if isinstance(exc, PartialCaptureRefused):
        return "partial_refused"
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
    frontier_hhmmss: int = 0  # raw collector encoding
    elapsed_ms: int = 0
    estimate_pct: int = 0
    result: CaptureResult | None = None
    error: CaptureError | None = None
    cancel_token: Any = None  # CancelToken; typed loosely to avoid circular import
    task: asyncio.Task | None = None

    def to_wire(self) -> CaptureJob:
        progress = None
        if self.pages_done > 0:
            progress = CaptureProgress(
                pages_done=self.pages_done,
                events_seen=self.events_seen,
                frontier_ms=0,  # filled by the route layer after timeenc conversion
                estimate_pct=self.estimate_pct,
                elapsed_ms=self.elapsed_ms,
            )
        return CaptureJob(
            job_id=self.job_id,
            code=self.code,
            date=self.date,
            phase=self.phase,  # type: ignore[arg-type]
            options=self.options,
            started_at_ms=self.started_at_ms,
            progress=progress,
            result=self.result,
            error=self.error,
        )

    @property
    def is_terminal(self) -> bool:
        return self.phase in ("done", "failed", "cancelled")


_lock = asyncio.Lock()
_latest: CaptureJobState | None = None


def get_latest() -> CaptureJobState | None:
    return _latest


def reset_state_for_tests() -> None:
    """For pytest fixtures only — clears the module singleton."""
    global _latest  # noqa: PLW0603 — intentional test-only reset of module singleton
    _latest = None


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


def _publish(evt: dict) -> None:
    """Thread-safe publish. Called from the executor thread for capture_*
    progress events; the call_soon_threadsafe hop ensures the SSE bus's
    asyncio.Queue.put_nowait runs on the event loop where the queue lives.
    """
    if _bus is None or _loop is None:
        return
    _loop.call_soon_threadsafe(_bus.publish, evt)


def _make_progress_callback(state: CaptureJobState):
    """Closure that updates `state` and emits an SSE event per ProgressEvent.

    Conversion seam (spec §4.3): HHMMSSmmm → Unix-ms happens HERE, not in collector.
    """
    def _on_progress(evt: ProgressEvent) -> None:
        state.pages_done = evt.pages_done
        state.events_seen = evt.events_seen
        state.frontier_hhmmss = evt.frontier_hhmmss
        state.elapsed_ms = int(time.time() * 1000) - state.started_at_ms
        # Estimate: % of Data Window covered (raw HHMMSSmmm math; see spec §5.5).
        span = CHART_FINAL_TIME_MS - DATA_WINDOW_START_MS
        offset = max(0, evt.frontier_hhmmss - DATA_WINDOW_START_MS)
        state.estimate_pct = min(98, max(0, int(100 * offset / span)))
        # SSE payload uses Unix-ms per ADR-0003.
        frontier_unix = hhmmssms_to_unix_ms(evt.date, evt.frontier_hhmmss)
        _publish({
            "type": "capture_progress",
            "job_id": state.job_id,
            "code": state.code,
            "date": state.date,
            "phase": state.phase,
            "pages_done": state.pages_done,
            "events_seen": state.events_seen,
            "frontier_ms": frontier_unix,
            "estimate_pct": state.estimate_pct,
            "elapsed_ms": state.elapsed_ms,
        })
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
    state.cancel_token = CancelToken()
    state.started_at_ms = int(time.time() * 1000)
    state.phase = "capturing"
    _publish({
        "type": "capture_phase",
        "job_id": state.job_id, "code": state.code, "date": state.date,
        "phase": state.phase,
    })

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
                allow_partial=bool(state.options.get("allow_partial", False)),
                resume=bool(state.options.get("resume", False)),
                on_progress=_make_progress_callback(state),
                cancel_token=state.cancel_token,
            ),
        )
        parsed = False
        if not state.options.get("capture_only", False):
            state.phase = "parsing"
            _publish({
                "type": "capture_phase",
                "job_id": state.job_id, "code": state.code, "date": state.date,
                "phase": state.phase,
            })
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
    except BaseException as exc:  # noqa: BLE001 — terminal failure path
        code = _exception_to_error_code(exc)
        state.error = CaptureError(
            code=code or "internal_error",
            message=str(exc),
            at_page=state.pages_done or None,
        )
        state.phase = "failed"

    _publish({
        "type": "capture_finished",
        "job_id": state.job_id, "code": state.code, "date": state.date,
        "phase": state.phase,
        "result": state.result.model_dump() if state.result else None,
        "error": state.error.model_dump() if state.error else None,
    })


KST = timezone(timedelta(hours=9))


class StartCaptureRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
    date: str = Field(pattern=r"^\d{8}$")
    allow_partial: bool = False
    resume: bool = False
    capture_only: bool = False


def _make_job_id(code: str, date: str) -> str:
    now = datetime.now(tz=KST).strftime("%Y%m%dT%H%M%S")
    return f"{now}-{code}-{date}"


def _state_to_wire(state: CaptureJobState) -> CaptureJob:
    """Wrap to_wire() with the timeenc conversion for frontier_ms."""
    wire = state.to_wire()
    if wire.progress is not None and state.frontier_hhmmss:
        wire = wire.model_copy(update={
            "progress": wire.progress.model_copy(update={
                "frontier_ms": hhmmssms_to_unix_ms(state.date, state.frontier_hhmmss),
            }),
        })
    return wire


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
                        "latest": _state_to_wire(_latest).model_dump(),
                    },
                )
            # Backend re-validation of partial capture (defense in depth).
            now_kst = datetime.now(tz=KST)
            if not req.allow_partial and _is_partial_capture(req.date, now_kst):
                raise HTTPException(
                    status_code=400,
                    detail={
                        "code": "partial_refused",
                        "message": (
                            f"date={req.date} is today (KST) before Data Window close."
                        ),
                    },
                )

            state = CaptureJobState(
                job_id=_make_job_id(req.code, req.date),
                code=req.code,
                date=req.date,
                options={
                    "allow_partial": req.allow_partial,
                    "resume": req.resume,
                    "capture_only": req.capture_only,
                },
            )
            _latest = state
            client = client_factory()
            state.task = asyncio.create_task(
                _run_capture_job(state=state, client=client, data_dir=data_dir)
            )
            return _state_to_wire(state)

    @router.get("/latest")
    async def get_latest_route() -> CaptureJob | None:
        if _latest is None:
            return None
        return _state_to_wire(_latest)

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
