"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from typing import Any

from hoga.api.models import (
    CaptureError,
    CaptureJob,
    CaptureProgress,
    CaptureResult,
)
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import CaptureCancelled, PartialCaptureRefused

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
