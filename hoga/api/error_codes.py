"""Single source of truth for backend-emitted error code strings.

Every `code` field that crosses the API surface — both REST responses
(``HTTPException(detail={"code": ..., "message": ...})``) and the per-item
``CaptureError.code`` field carried on SSE ``capture_finished`` events —
draws from one of these enums.

There are two enums, split by category (see ADR-0009):

* :class:`CaptureErrorCode` — captures-domain non-upstream codes
  (request gating, lifecycle states, internal-error fallback).

* :class:`UpstreamCode` — upstream-dependency availability codes
  (KRX login state, hogaplay cookie state, hogaplay HTTP errors).
  Used as ``reason: UpstreamCode | None`` on cache envelopes
  (``SymbolsAllResponse``, ``CalendarResponse``), as
  ``detail.code: UpstreamCode`` on HTTP 5xx error responses, and as
  ``CaptureError.code`` on per-item SSE failures.

The frontend mirrors both enums verbatim as literal unions in
``frontend/src/api/types.ts`` (ADR-0004 mirror discipline: codes are
part of the wire contract, not an internal implementation detail).
Adding a new value here means adding the same string to the
corresponding frontend union in the same commit.
"""
from __future__ import annotations

from enum import StrEnum


class CaptureErrorCode(StrEnum):
    """Captures-domain non-upstream codes (ADR-0009).

    Migrated 2026-05-22: cookie/hogaplay codes moved to UpstreamCode.
    """

    TODAY_TOO_EARLY = "today_too_early"
    MISSING_RANGE = "missing_range"
    TERMINAL = "terminal"
    NOT_FOUND = "not_found"
    INTERNAL_ERROR = "internal_error"


class UpstreamCode(StrEnum):
    """Upstream-dependency availability codes (ADR-0009).

    Used for:
      * cache-style envelopes (HTTP 200) as ``reason: UpstreamCode | None``
      * HTTP error responses (5xx) as ``detail.code: UpstreamCode``
      * SSE per-item failure ``CaptureError.code`` (alongside CaptureErrorCode)

    String values are stable across surfaces; the field name (``reason``
    vs ``code``) signals the response shape.
    """

    KRX_CREDENTIALS_MISSING = "krx_credentials_missing"
    KRX_FETCH_FAILED = "krx_fetch_failed"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
