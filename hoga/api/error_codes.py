"""Single source of truth for backend-emitted error code strings.

Every `code` field that crosses the API surface — both REST responses
(``HTTPException(detail={"code": ..., "message": ...})``) and the per-item
``CaptureError.code`` field carried on SSE ``capture_finished`` events —
draws from this enum.

The frontend mirrors this verbatim as a literal union in
``frontend/src/api/types.ts::CaptureErrorCode`` (ADR-0004 mirror discipline:
codes are part of the wire contract, not an internal implementation
detail). Adding a new value here means adding the same string to the
frontend union in the same commit.
"""
from __future__ import annotations

from enum import StrEnum


class CaptureErrorCode(StrEnum):
    """Closed set of error codes emitted by the captures router.

    Categories (informal — both flow through the same wire field):
    - REST request gating: TODAY_TOO_EARLY, MISSING_RANGE, TERMINAL, NOT_FOUND
    - Per-item failure classification (CaptureError.code on capture_finished):
      COOKIE_EXPIRED, COOKIE_MISSING, HOGAPLAY_HTTP_ERROR
    - Fallback: INTERNAL_ERROR
    """

    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"
