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
    # Queue mutation attempted on a server that does not own the capture queue
    # for this data dir (another instance holds the flock — ADR-0094). HTTP 503.
    QUEUE_NOT_OWNED = "queue_not_owned"


class UpstreamCode(StrEnum):
    """Upstream-dependency availability codes (ADR-0009).

    Used for:
      * cache-style envelopes (HTTP 200) as ``reason: UpstreamCode | None``
      * HTTP error responses (5xx) as ``detail.code: UpstreamCode``
      * SSE per-item failure ``CaptureError.code`` (alongside CaptureErrorCode)

    String values are stable across surfaces; the field name (``reason``
    vs ``code``) signals the response shape.
    """

    # KIS chk-holiday trading-day fetch failure (Phase 3) — HTTP/rt_cd errors
    # and parse failures on the calendar path. Transient; remediation = retry.
    KIS_HOLIDAY_FETCH_FAILED = "kis_holiday_fetch_failed"
    # KIS credentials absent (KIS_APP_KEY/KIS_APP_SECRET unset) — distinct from
    # FETCH_FAILED so UIs give the right remediation ("set keys" vs "retry
    # later"); same principle as DISK_WRITE_FAILED vs KIS_MASTER_FETCH_FAILED.
    KIS_CREDENTIALS_MISSING = "kis_credentials_missing"
    COOKIE_EXPIRED = "cookie_expired"
    COOKIE_MISSING = "cookie_missing"
    HOGAPLAY_HTTP_ERROR = "hogaplay_http_error"
    SYMBOL_MASTER_NOT_INITIALIZED = "symbol_master_not_initialized"
    # Disk-write failure during a cache flush — distinguishes "the upstream
    # source is down" (KIS_MASTER_FETCH_FAILED) from "the upstream returned data
    # but we couldn't persist it" (full volume, EACCES, detached volume).
    # Operators see distinct reasons; UIs can surface a different remediation
    # ("free disk space" vs "check KIS credentials").
    DISK_WRITE_FAILED = "disk_write_failed"
    # KIS .mst symbol-master download/unzip/parse failure (Phase 2). The .mst is
    # a static no-auth file, so there is no credentials failure mode here.
    KIS_MASTER_FETCH_FAILED = "kis_master_fetch_failed"
