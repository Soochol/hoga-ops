"""Unit tests for hoga.api.captures._exception_to_error_code (spec §4.1 table)."""
from __future__ import annotations

import asyncio
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
from hoga.api.timeenc import HogaMs, hhmmssms_to_unix_ms
from hoga.collector import orchestrator as orch
from hoga.collector.client import CookieExpiredError, HogaplayHTTPError
from hoga.collector.orchestrator import (
    CaptureCancelled,
    ProgressEvent,
    TodayTooEarlyRefused,
)
from hoga.config import CookieMissingError


def test_maps_today_too_early() -> None:
    assert _exception_to_error_code(TodayTooEarlyRefused("x")) == "today_too_early"


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
        options={"resume": False, "capture_only": False},
    )
    assert state.to_wire().phase == "capturing"
    assert state.to_wire().progress is None
    assert state.to_wire().error is None


def test_to_wire_converts_frontier_to_unix_ms() -> None:
    """state.to_wire() is the single encoding seam — caller never touches HHMMSSmmm.

    The conversion delegates to hoga.api.timeenc.hhmmssms_to_unix_ms (the same
    helper ADR-0003 mandates as the project-wide source of truth). We assert
    against the helper rather than a hand-computed number so this test stays
    correct if the helper's KST offset / DST handling ever evolves.
    """
    state = CaptureJobState(
        job_id="job-1",
        code="005930",
        date="20260520",
        options={"resume": False, "capture_only": False},
        pages_done=5,
        events_seen=100,
        frontier=HogaMs(132400000),  # 13:24:00.000
    )
    wire = state.to_wire()
    assert wire.progress is not None
    assert wire.progress.frontier_ms == hhmmssms_to_unix_ms("20260520", HogaMs(132400000))
    # Sanity: result is a plausible Unix-ms (post-2025, pre-2030).
    assert 1_735_689_600_000 < wire.progress.frontier_ms < 1_893_456_000_000


@pytest.mark.asyncio
async def test_lock_acquire_release_roundtrip() -> None:
    async with _lock:
        pass  # smoke test: lock is an asyncio.Lock, usable in async ctx


@pytest.mark.asyncio
async def test_progress_callback_hops_to_loop_when_wired() -> None:
    """When _loop is wired, the callback dispatches via call_soon_threadsafe
    instead of mutating state inline. This is the single-thread invariant —
    all CaptureJobState mutation happens on the event loop, not the collector
    thread. Race window between callback and concurrent reads is eliminated.
    """
    loop = asyncio.get_running_loop()
    cap_mod.set_bus(_StubBus(), loop)
    try:
        state = CaptureJobState(
            job_id="j-thread",
            code="005930",
            date="20260520",
            options={"resume": False, "capture_only": True},
            started_at_ms=int(asyncio.get_running_loop().time() * 1000),
        )
        callback = cap_mod._make_progress_callback(state)
        evt = ProgressEvent(
            code="005930", date="20260520",
            pages_done=5, events_seen=100, frontier=HogaMs(132400000),
        )
        callback(evt)
        # Mutation has NOT happened yet — it's scheduled on the loop.
        assert state.pages_done == 0
        # Yield to let the scheduled callback run.
        await asyncio.sleep(0)
        assert state.pages_done == 5
        assert state.frontier == 132400000
    finally:
        cap_mod.set_bus(None, None)


class _StubBus:
    """Minimal bus that swallows publishes — keeps _publish_event a no-op
    without spinning up the real SSE infrastructure.
    """
    def publish(self, evt: dict) -> None:  # noqa: ARG002
        del evt


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
        options={"resume": False, "capture_only": True, "_fast_test": True},
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


def test_post_captures_400_when_cookie_missing(tmp_path: Path, _patch_run_job) -> None:
    """client_factory raising CookieMissingError → 400, NOT 500.

    Regression for the bug where the factory ran AFTER _latest was assigned,
    so a missing cookie left _latest stuck in "capturing" forever and every
    subsequent POST returned 409 already_running.
    """
    del _patch_run_job
    reset_state_for_tests()

    def _failing_factory():
        raise CookieMissingError("No cookie found. test fixture.")

    client = _make_app(tmp_path, _failing_factory)
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "cookie_missing"

    # AND _latest must NOT be polluted — a follow-up POST should NOT see 409.
    # We can't actually retry without a working factory, but we can verify
    # via GET that the singleton is clean.
    r2 = client.get("/api/captures/latest")
    assert r2.status_code == 200
    assert r2.json() is None, "stuck _latest pollutes singleton — the bug"


def test_post_captures_returns_201(tmp_path: Path, _patch_run_job) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["code"] == "005930"
    assert body["date"] == "20260520"
    assert body["phase"] == "capturing"
    # `options` was on the old CaptureJob; QueueItem (Task 2) dropped it. Test
    # dies in Task 13 with the rest of the legacy singleton.
    assert body["item_id"]


def test_post_captures_400_today_too_early(
    tmp_path: Path, monkeypatch, _patch_run_job,
) -> None:
    """Today's KST date before 18:00 → 400 today_too_early.

    Mocks the KST clock used by is_today_too_early by patching `datetime.now`
    inside hoga.collector.orchestrator so the route's guard sees 'today'.
    """
    del _patch_run_job
    # Pretend today is 2026-05-20 at 17:30 KST (before 18:00 cutoff).
    fixed_now = _dt.datetime(2026, 5, 20, 17, 30, tzinfo=_dt.timezone(_dt.timedelta(hours=9)))

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
        "resume": False, "capture_only": True,
    })
    assert r.status_code == 400
    assert r.json()["detail"]["code"] == "today_too_early"


def test_post_captures_409_when_running(tmp_path: Path, _patch_run_job) -> None:
    reset_state_for_tests()
    # With _run_capture_job patched to a no-op, state.phase stays at "capturing"
    # (non-terminal), so the second POST sees _latest.is_terminal == False and
    # returns 409.
    client = _make_app(tmp_path, _FakeFastClient)
    r1 = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    assert r1.status_code == 201
    r2 = client.post("/api/captures", json={
        "code": "000660", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    assert r2.status_code == 409
    assert r2.json()["detail"]["latest"]["code"] == "005930"


def test_get_latest_null_when_idle(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.get("/api/captures/latest")
    assert r.status_code == 200
    assert r.json() is None


def test_cancel_when_idle_409(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.post("/api/captures/latest/cancel")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "not_running"


def test_dismiss_when_idle_204(tmp_path: Path) -> None:
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.delete("/api/captures/latest")
    assert r.status_code == 204


def test_dismiss_when_running_409(tmp_path: Path, _patch_run_job) -> None:
    """POST a capture (mocked to no-op), then DELETE → 409 still_running."""
    del _patch_run_job
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    r1 = client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    assert r1.status_code == 201
    r2 = client.delete("/api/captures/latest")
    assert r2.status_code == 409
    assert r2.json()["detail"]["code"] == "still_running"


def test_cancel_running_returns_202(tmp_path: Path, _patch_run_job) -> None:
    """POST a job (mocked), POST /latest/cancel → 202."""
    del _patch_run_job
    reset_state_for_tests()
    client = _make_app(tmp_path, _FakeFastClient)
    client.post("/api/captures", json={
        "code": "005930", "date": "20260520",
        "resume": False, "capture_only": True,
    })
    r = client.post("/api/captures/latest/cancel")
    assert r.status_code == 202


def test_dismiss_after_terminal_clears(tmp_path: Path) -> None:
    """Manually set _latest to a terminal state, DELETE → 204, GET → null."""
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="done-job",
        code="005930",
        date="20260520",
        options={"resume": False, "capture_only": True},
        phase="done",
    )
    cap_mod._latest = state
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.delete("/api/captures/latest")
    assert r.status_code == 204
    r2 = client.get("/api/captures/latest")
    assert r2.json() is None


def test_cancel_when_terminal_409(tmp_path: Path) -> None:
    """latest is `done` → POST /latest/cancel returns 409 not_running."""
    reset_state_for_tests()
    state = CaptureJobState(
        job_id="done-job",
        code="005930",
        date="20260520",
        options={"resume": False, "capture_only": True},
        phase="done",
    )
    cap_mod._latest = state
    client = _make_app(tmp_path, _FakeFastClient)
    r = client.post("/api/captures/latest/cancel")
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "not_running"
