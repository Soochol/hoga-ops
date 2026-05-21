"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

import pytest

from hoga.api.captures import (
    CaptureJobState,
    _exception_to_error_code,
    _lock,
    get_latest,
    reset_state_for_tests,
)
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


@pytest.fixture(autouse=True)
def _reset_state() -> None:
    """Clear module-level singleton between tests."""
    reset_state_for_tests()


def test_get_latest_is_none_initially() -> None:
    assert get_latest() is None


def test_capture_job_state_initial_phase() -> None:
    state = CaptureJobState(
        job_id="20260521T100000-005930-20260520",
        code="005930",
        date="20260520",
        options={"allow_partial": False, "resume": False, "capture_only": False},
    )
    assert state.to_wire().phase == "capturing"
    assert state.to_wire().progress is None
    assert state.to_wire().error is None


@pytest.mark.asyncio
async def test_lock_acquire_release_roundtrip() -> None:
    async with _lock:
        pass  # smoke test: lock is an asyncio.Lock, usable in async ctx
