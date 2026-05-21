"""Capture orchestration: route handlers + background asyncio task + singleton state.

See docs/superpowers/specs/2026-05-21-capture-ui-design.md §4.
"""
from __future__ import annotations

import os

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
