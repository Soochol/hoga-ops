"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

import datetime as _dt
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import captures as cap_mod
from hoga.api.captures import (
    CaptureJobState,
    _exception_to_error_code,
    _lock,
    _run_capture_job,
    build_router,
    get_latest,
    reset_state_for_tests,
)
from hoga.collector import orchestrator as orch
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


def _make_app(tmp_path: Path, fake_client_factory) -> TestClient:
    app = FastAPI()
    app.include_router(build_router(
        data_dir=tmp_path,
        client_factory=fake_client_factory,
    ))
    return TestClient(app)


@pytest.fixture
def _patch_run_job(monkeypatch):
    """Replace _run_capture_job with a no-op for HTTP-layer tests.

    The real job uses loop.run_in_executor, which TestClient waits on before
    delivering the response. With FakeFastClient at rate_limit_s=0.2 driving
    the Page Step loop to t >= DATA_WINDOW_END_MS (~1300 iterations), the
    "201 should come back immediately" test would take minutes.

    This fixture isolates the HTTP layer (lock acquisition, validation,
    state.phase wiring). The collector path is covered by
    test_run_capture_job_reaches_done above.
    """
    async def _noop(*, state, client, data_dir):  # noqa: ARG001
        # Leave state.phase at its "capturing" default so is_terminal stays False.
        return
    monkeypatch.setattr(cap_mod, "_run_capture_job", _noop)


def test_post_captures_returns_201(tmp_path: Path, _patch_run_job) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["code"] == "005930"
    assert body["date"] == "20260520"
    assert body["phase"] == "capturing"
    assert body["options"]["allow_partial"] is True


def test_post_captures_400_partial_refused(
    tmp_path: Path, monkeypatch, _patch_run_job,
) -> None:
    """Today's KST date with allow_partial=false → 400 partial_refused.

    Mocks the KST clock used by _is_partial_capture by patching `datetime.now`
    inside hoga.collector.orchestrator so the route's guard sees 'today'.
    """
    # Pretend today is 2026-05-20 at 10:00 KST (before 16:00 Data Window close).
    fixed_now = _dt.datetime(2026, 5, 20, 10, 0, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))

    class _FixedDateTime(_dt.datetime):
        @classmethod
        def now(cls, tz=None):
            del tz
            return fixed_now

    monkeypatch.setattr(orch.dt, "datetime", _FixedDateTime)
    monkeypatch.setattr(cap_mod, "datetime", _FixedDateTime, raising=False)

    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",  # matches fixed_now date
        "allow_partial": False, "resume": False, "capture_only": True,
    })
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "partial_refused"


def test_post_captures_409_when_running(tmp_path: Path, _patch_run_job) -> None:
    reset_state_for_tests()
    # With _run_capture_job patched to a no-op, state.phase stays at "capturing"
    # (non-terminal), so the second POST sees _latest.is_terminal == False and
    # returns 409.
    client = _make_app(tmp_path, _FakeFastClient)
    r1 = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r1.status_code == 201
    r2 = client.post("/api/captures", json={
        "code": "000660", "date": "20260520",
        "allow_partial": True, "resume": False, "capture_only": True,
    })
    assert r2.status_code == 409
    assert r2.json()["detail"]["latest"]["code"] == "005930"
