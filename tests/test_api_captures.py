"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

from hoga.api.captures import _exception_to_error_code
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import CaptureCancelled, PartialCaptureRefused


def test_maps_partial_refused() -> None:
    assert _exception_to_error_code(PartialCaptureRefused("x")) == "partial_refused"


def test_maps_cookie_expired() -> None:
    assert _exception_to_error_code(CookieExpiredError("x")) == "cookie_expired"


def test_maps_hogaplay_http_error() -> None:
    assert _exception_to_error_code(HogaplayHTTPError("x")) == "hogaplay_http_error"


def test_capture_cancelled_returns_none() -> None:
    # CaptureCancelled is not an "error" — phase transitions to `cancelled`, not `failed`.
    assert _exception_to_error_code(CaptureCancelled("x")) is None


def test_maps_any_other_to_internal_error() -> None:
    assert _exception_to_error_code(RuntimeError("boom")) == "internal_error"
    assert _exception_to_error_code(ValueError("nope")) == "internal_error"
