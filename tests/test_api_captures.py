"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

from pathlib import Path

import pytest

from hoga.api import captures as cap_mod
from hoga.api.captures import (
    CaptureJobState,
    _exception_to_error_code,
    _lock,
    _run_capture_job,
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


class _FakeFastClient:
    """3 pages then empty, no rate limit."""
    def __init__(self) -> None:
        self.first_calls = 0
    def fetch_info(self, code: str, date: str) -> str:
        del code, date
        return "k\tv\n"
    def fetch_first(self, code: str, date: str, time_ms: int) -> str:
        del code, date, time_ms
        self.first_calls += 1
        if self.first_calls > 3:
            return ""
        base = self.first_calls * 1000
        t = 90000000 + (self.first_calls - 1) * 60000
        return "\n".join(f"1\t1\t0\t{base+i}\t{t+i}\t0\t100" for i in range(3)) + "\n"
    def fetch_chart(self, code: str, date: str, time_ms: int, **_) -> str:
        del code, date, time_ms
        return ""


@pytest.mark.asyncio
async def test_run_capture_job_reaches_done(tmp_path: Path) -> None:
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="job-1",
        code="005930",
        date="20260520",
        options={"allow_partial": True, "resume": False, "capture_only": True, "_fast_test": True},
    )
    cap_mod._latest = state

    await _run_capture_job(
        state=state,
        client=_FakeFastClient(),
        data_dir=tmp_path,
    )

    assert state.phase == "done"
    assert state.result is not None
    assert state.result.pages_written >= 1
    assert state.started_at_ms > 0
    assert state.pages_done >= 1
