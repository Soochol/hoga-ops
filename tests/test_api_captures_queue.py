"""Plan B queue/worker tests. Built up across Tasks 3–15."""
from __future__ import annotations

import asyncio
import json
import time

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import captures
from hoga.api.captures import QueueItemState
from hoga.api.captures_fake import FakeHogaplayClient
from hoga.api.captures_persistence import manifest_path
from hoga.api.disk_state import Classification, DiskState
from hoga.api.models import CapturePhase, RetrySkippedRow


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def test_initial_snapshot_is_empty():
    snap = captures.get_queue_snapshot()
    assert snap.active == []
    assert snap.queued == []
    assert snap.done == []
    assert snap.paused is False
    assert snap.max_concurrent >= 1


def test_max_concurrent_reads_env_default_3(monkeypatch):
    monkeypatch.delenv("HOGA_MAX_CONCURRENT", raising=False)
    snap = captures.get_queue_snapshot()
    # Default 3 unless overridden — but the module reads env at import time,
    # so we just check it's a positive int matching what the module loaded.
    assert isinstance(snap.max_concurrent, int) and snap.max_concurrent >= 1


def test_reset_state_clears_queue_active_done_and_pause():
    # Mutate then reset, then re-check.
    captures._queue.append(object())  # type: ignore[arg-type]
    captures._active["x"] = object()  # type: ignore[assignment]
    captures._done.append(object())   # type: ignore[arg-type]
    captures._inflight_paths.add(("005930", "20260520"))
    captures._queue_paused = True
    captures.reset_state_for_tests()
    snap = captures.get_queue_snapshot()
    assert snap.queued == [] and snap.active == [] and snap.done == []
    assert snap.paused is False
    assert captures._inflight_paths == set()


def _make_item(item_id: str, code: str = "005930", date: str = "20260520"):
    return QueueItemState(
        item_id=item_id, code=code, date=date,
        force_retry=False, enqueued_at_ms=int(time.time() * 1000),
    )


async def test_worker_pool_drains_three_items_with_stub_runner(monkeypatch):
    """With a stub _run_item that just marks done, the worker pool transitions
    all queued items to done."""
    # Stub the collector path with a no-op.
    async def _stub_run(state):
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_item", _stub_run)
    monkeypatch.setattr(captures, "_max_concurrent", 3, raising=False)

    for i in range(3):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))

    workers = captures.start_workers(n=3)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert len(snap.done) == 3
    assert all(item.phase == "done" for item in snap.done)


async def test_worker_pool_respects_max_concurrent(monkeypatch):
    """With max_concurrent=2 and a slow stub runner, only 2 items are active at once."""
    sem = asyncio.Semaphore(0)
    max_seen_active = 0

    async def _slow_run(state):
        nonlocal max_seen_active
        max_seen_active = max(max_seen_active, len(captures._active))
        await sem.acquire()
        state.phase = "done"

    monkeypatch.setattr(captures, "_run_item", _slow_run)
    monkeypatch.setattr(captures, "_max_concurrent", 2, raising=False)

    for i in range(5):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))

    workers = captures.start_workers(n=2)
    # Let the loop tick so 2 items become active.
    await asyncio.sleep(0.05)
    assert len(captures._active) == 2
    # Release them one at a time.
    for _ in range(5):
        sem.release()
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert max_seen_active == 2


@pytest.mark.asyncio
async def test_deciding_skips_complete(monkeypatch, tmp_path):
    """When disk_state.check_disk_state returns COMPLETE, item is skipped."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.COMPLETE))

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "skipped"
    assert snap.done[0].skip_reason == "already_complete"


@pytest.mark.asyncio
async def test_deciding_retries_source_partial(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.SOURCE_PARTIAL))

    captured = {}
    async def _stub_capture(state, resume, **_kwargs):
        captured["resume"] = resume
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _stub_capture)

    captures._queue.append(_make_item("x-1"))  # force_retry=False
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert captured.get("resume") is False
    assert snap.done[0].phase == "done"


@pytest.mark.asyncio
async def test_deciding_resumes_client_incomplete(monkeypatch, tmp_path):
    """CLIENT_INCOMPLETE forces resume=True in the collector call."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.CLIENT_INCOMPLETE))

    captured = {}
    async def _stub_capture(state, resume, **_kwargs):
        captured["resume"] = resume
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _stub_capture)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert captured.get("resume") is True


@pytest.mark.asyncio
async def test_force_retry_overrides_source_partial_skip(monkeypatch, tmp_path):
    """SOURCE_PARTIAL + force_retry=True → falls through to fresh capture."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.SOURCE_PARTIAL))

    captured = {}
    async def _stub_capture(state, resume, **_kwargs):
        captured["resume"] = resume
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_and_parse", _stub_capture)

    item = _make_item("x-1")
    item.force_retry = True
    captures._queue.append(item)
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert captured.get("resume") is False  # fresh, not resume
    snap = captures.get_queue_snapshot()
    assert snap.done[0].phase == "done"


@pytest.mark.asyncio
async def test_worker_defers_when_inflight_collision(monkeypatch, tmp_path):
    """If two items have the same (code, date) and the first is already in
    _inflight_paths, the second worker requeues it instead of double-running."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))

    start_order: list[str] = []
    finish_order: list[str] = []
    sem = asyncio.Semaphore(0)

    async def _capture(state, resume, **_kwargs):
        start_order.append(state.item_id)
        await sem.acquire()
        state.phase = "done"
        finish_order.append(state.item_id)
    monkeypatch.setattr(captures, "_run_capture_and_parse", _capture)

    # Both items share (005930, 20260520)
    captures._queue.append(_make_item("x-1", date="20260520"))
    captures._queue.append(_make_item("x-2", date="20260520"))

    workers = captures.start_workers(n=2)
    await asyncio.sleep(0.1)
    # Only one started; the other got requeued.
    assert len(start_order) == 1
    sem.release()
    await asyncio.sleep(0.1)
    sem.release()
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    assert sorted(finish_order) == ["x-1", "x-2"]


# --- Task 7: POST /api/captures/items HTTP-level tests ----------------------

import datetime as dt  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402


def _build_test_app(monkeypatch, tmp_path):
    """Build a real FastAPI app pointed at tmp_path. Tests should monkeypatch
    around live KRX access via hoga.api.captures._expand_to_trading_days OR
    hoga.api.calendar.trading_days_in_range BEFORE entering the TestClient
    context (the lifespan starts the worker pool eagerly).

    The lifespan also starts workers; tests that need items to remain queued
    should monkeypatch ``captures.start_workers`` to return [] so the pool is
    inert.
    """
    monkeypatch.setenv("HOGA_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    from hoga.api.app import create_app
    return create_app(tmp_path)


def _no_workers(monkeypatch):
    """Disable the lifespan-started worker pool so enqueued items stay queued.
    Use in tests that assert against post-enqueue snapshot or dedupe-against-
    queue behavior (vs dedupe-against-active)."""
    monkeypatch.setattr(captures, "start_workers", lambda *a, **k: [], raising=True)


def test_enqueue_expands_date_range_to_trading_days(monkeypatch, tmp_path):
    """start_date=20260518 (Mon) end_date=20260520 (Wed) → 3 trading-day items."""
    _no_workers(monkeypatch)
    monkeypatch.setattr(
        "hoga.api.calendar.trading_days_in_range",
        lambda s, e: ["20260518", "20260519", "20260520"],
    )
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "start_date": "20260518", "end_date": "20260520",
            "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 3
        assert [it["date"] for it in body["enqueued"]] == ["20260518", "20260519", "20260520"]
        assert body["deduped"] == []


def test_enqueue_skips_weekend_dates(monkeypatch, tmp_path):
    """Range spanning a weekend yields only weekday items."""
    _no_workers(monkeypatch)
    # Fri 2026-05-15, Mon 2026-05-18 — Sat/Sun skipped.
    monkeypatch.setattr(
        "hoga.api.calendar.trading_days_in_range",
        lambda s, e: ["20260515", "20260518"],
    )
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "start_date": "20260515", "end_date": "20260518",
            "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert {it["date"] for it in body["enqueued"]} == {"20260515", "20260518"}


def test_enqueue_rejects_today_pre_17_kst(monkeypatch, tmp_path):
    """A date matching today_kst before 17:00 → 400 today_too_early."""
    _no_workers(monkeypatch)
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 22, 16, 30, 0, tzinfo=KST)
    monkeypatch.setattr(captures, "_now_kst", lambda: fixed_now)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260522"], "force_retry": False,
        })
        assert r.status_code == 400
        body = r.json()
        assert body["detail"]["code"] == "today_too_early"


def test_enqueue_dedupes_duplicate_dates_in_request(monkeypatch, tmp_path):
    """Same (code, date) submitted twice in one request → one enqueued, one deduped."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520", "20260520"], "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert len(body["deduped"]) == 1
        assert body["deduped"][0]["reason"] == "already_in_queue"
        assert body["deduped"][0]["date"] == "20260520"


def test_enqueue_dedupes_against_existing_queue(monkeypatch, tmp_path):
    """A second POST for the same (code, date) returns it under `deduped`."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        first = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert first.status_code == 201, first.text
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 201
        body = r.json()
        assert body["enqueued"] == []
        assert len(body["deduped"]) == 1
        assert body["deduped"][0]["reason"] == "already_in_queue"


def test_enqueue_requires_either_range_or_dates(monkeypatch, tmp_path):
    """Neither dates nor start/end → 400 missing_range."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={"code": "005930", "force_retry": False})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "missing_range"


# --- Task 8: GET /api/captures/queue snapshot route -------------------------


def test_get_queue_returns_snapshot(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    # Avoid live KRX: stub trading_days_in_range to return the single date.
    monkeypatch.setattr("hoga.api.calendar.trading_days_in_range",
                        lambda s, e: [s])
    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        r = c.get("/api/captures/queue")
        assert r.status_code == 200
        body = r.json()
        assert "active" in body and "queued" in body and "done" in body
        assert "paused" in body and "max_concurrent" in body
        assert isinstance(body["max_concurrent"], int)


# --- Task 9: Cancel routes --------------------------------------------------


def test_cancel_queued_item_removes_and_marks_cancelled(monkeypatch, tmp_path):
    """Item not yet active → POST /cancel drops it from queue, marks cancelled."""
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    # Patch _run_capture_and_parse to block so items stay queued/active.
    sem = asyncio.Event()

    async def _block(state, resume, **_kwargs):
        await sem.wait()
        state.phase = "done"

    monkeypatch.setattr(captures, "_run_capture_and_parse", _block)

    with TestClient(app) as c:
        # Enqueue more items than workers so at least one stays in _queue.
        # _max_concurrent defaults to 3; submit 5 to be safe.
        r = c.post("/api/captures/items", json={
            "code": "005930",
            "dates": ["20260513", "20260514", "20260515", "20260518", "20260519"],
            "force_retry": False,
        })
        assert r.status_code == 201, r.text
        items = r.json()["enqueued"]
        # Target the last one — it'll still be in the queue (workers blocked).
        target = items[-1]
        # Give workers a moment to pick up the first batch so target sits in _queue.
        for _ in range(20):
            snap = c.get("/api/captures/queue").json()
            if any(it["item_id"] == target["item_id"] for it in snap["queued"]):
                break
            time.sleep(0.02)
        cr = c.post(f"/api/captures/items/{target['item_id']}/cancel")
        assert cr.status_code == 202, cr.text
        body = cr.json()
        assert body["status"] == "cancelled"
        assert body["item_id"] == target["item_id"]
        # Snapshot should show it in done with cancelled phase.
        snap = c.get("/api/captures/queue").json()
        cancelled = [it for it in snap["done"] if it["item_id"] == target["item_id"]]
        assert cancelled and cancelled[0]["phase"] == "cancelled"
        # Let the rest drain so the test teardown is clean.
        sem.set()


def test_cancel_terminal_item_returns_409(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.COMPLETE))
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518"], "force_retry": False,
        })
        item_id = r.json()["enqueued"][0]["item_id"]
        # Wait for it to terminate (COMPLETE → skipped, terminal).
        for _ in range(40):
            snap = c.get("/api/captures/queue").json()
            if snap["active"] == [] and any(it["item_id"] == item_id for it in snap["done"]):
                break
            time.sleep(0.05)
        cr = c.post(f"/api/captures/items/{item_id}/cancel")
        assert cr.status_code == 409, cr.text
        assert cr.json()["detail"]["code"] == "terminal"


def test_cancel_all_drains_queue(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    sem = asyncio.Event()

    async def _block(state, resume, **_kwargs):
        await sem.wait()
        state.phase = "done"

    monkeypatch.setattr(captures, "_run_capture_and_parse", _block)

    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260518", "20260519", "20260520"],
            "force_retry": False,
        })
        cr = c.post("/api/captures/cancel-all")
        assert cr.status_code == 202, cr.text
        body = cr.json()
        assert body["status"] == "cancel_all_delivered"
        assert "drained_count" in body
        sem.set()
        # All terminal.
        for _ in range(60):
            snap = c.get("/api/captures/queue").json()
            if not snap["queued"] and not snap["active"]:
                break
            time.sleep(0.05)
        snap = c.get("/api/captures/queue").json()
        assert snap["queued"] == []
        assert snap["active"] == []
        assert all(it["phase"] in ("done", "cancelled") for it in snap["done"])


# --- Task 10: cookie expiry pause + resume + Q20 cancel-all semantics -------


async def test_cookie_expired_pauses_pool(monkeypatch):
    """When _run_capture_and_parse raises CookieExpiredError, the whole pool
    pauses and OTHER active items are cancelled with pause_origin=True."""
    from hoga.collector.client import CookieExpiredError
    from hoga.collector.orchestrator import CaptureCancelled, CancelToken

    # Synchronization: the runner that throws cookie-expired waits until all
    # 3 workers are active before raising, so the OTHER active items exist
    # when _handle_cookie_expired sweeps _active.
    barrier = asyncio.Event()

    async def _runner(state, resume, **_kwargs):
        # Ensure cancel_token is set so _handle_cookie_expired can trip it.
        if state.cancel_token is None:
            state.cancel_token = CancelToken()
        # Wait until all 3 workers are active.
        for _ in range(500):
            if len(captures._active) >= 3:
                break
            await asyncio.sleep(0.005)
        # The designated "cookie expirer" is whichever worker ended up with x-0.
        if state.item_id == "x-0":
            raise CookieExpiredError("cookie expired")
        # Other workers block until the pause cancels their token.
        while True:
            if state.cancel_token is not None and state.cancel_token.cancelled:
                raise CaptureCancelled()
            try:
                await asyncio.wait_for(barrier.wait(), timeout=0.02)
            except asyncio.TimeoutError:
                continue

    # Bypass disk-state checks (route into _run_capture_and_parse directly).
    async def _direct_run(state):
        await captures._run_capture_and_parse(state, resume=False)

    monkeypatch.setattr(captures, "_run_capture_and_parse", _runner)
    monkeypatch.setattr(captures, "_run_item", _direct_run)
    monkeypatch.setattr(captures, "_max_concurrent", 3, raising=False)

    for i in range(3):
        captures._queue.append(_make_item(f"x-{i}", date=f"2026052{i}"))

    workers = captures.start_workers(n=3)
    # Wait until pool reports paused.
    for _ in range(500):
        if captures._queue_paused:
            break
        await asyncio.sleep(0.01)
    assert captures._queue_paused is True

    # Wait for the other two to land in _done as pause-cancelled.
    for _ in range(500):
        pause_cancelled = [
            s for s in captures._done
            if s.pause_origin and s.phase == "cancelled"
        ]
        if len(pause_cancelled) >= 1:
            break
        await asyncio.sleep(0.01)
    pause_cancelled = [
        s for s in captures._done
        if s.pause_origin and s.phase == "cancelled"
    ]
    assert len(pause_cancelled) >= 1
    await captures.stop_workers(workers)


async def test_resume_reenqueues_pause_origin():
    """resume_queue() moves pause_origin items from _done back to the FRONT
    of _queue, clears flags, and clears _queue_paused."""
    s1 = _make_item("p-1", date="20260518")
    s1.phase = "cancelled"
    s1.pause_origin = True
    s2 = _make_item("p-2", date="20260519")
    s2.phase = "cancelled"
    s2.pause_origin = True
    captures._done.append(s1)
    captures._done.append(s2)
    captures._queue_paused = True

    await captures.resume_queue()

    assert captures._queue_paused is False
    assert s1 not in captures._done
    assert s2 not in captures._done
    queued_ids = [s.item_id for s in captures._queue]
    assert "p-1" in queued_ids and "p-2" in queued_ids
    for s in captures._queue:
        assert s.phase == "queued"
        assert s.pause_origin is False


async def test_cancel_all_in_paused_resets_everything():
    """Q20: cancel_all() called while _queue_paused clears the pause flag and
    downgrades pause_origin items to plain cancelled."""
    paused_item = _make_item("p-1", date="20260518")
    paused_item.phase = "cancelled"
    paused_item.pause_origin = True
    captures._done.append(paused_item)

    queued_item = _make_item("q-1", date="20260519")
    captures._queue.append(queued_item)

    captures._queue_paused = True

    result = await captures.cancel_all()

    assert result["was_paused"] is True
    assert captures._queue_paused is False
    assert paused_item.pause_origin is False
    # Both items now in _done with cancelled phase; queue empty.
    assert len(captures._queue) == 0
    done_ids = {s.item_id for s in captures._done}
    assert {"p-1", "q-1"} <= done_ids
    for s in captures._done:
        if s.item_id in {"p-1", "q-1"}:
            assert s.phase == "cancelled"


# ---------------------------------------------------------------------------
# Task 11: 429 per-item exponential backoff + cancel-aware sleep
# ---------------------------------------------------------------------------


async def test_429_backoff_then_success(monkeypatch, tmp_path):
    """3 consecutive 429s succeed on the 4th attempt; phase=done."""
    from hoga.collector.client import HogaplayHTTPError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    # Zero the backoff so the test doesn't actually wait 5+10+30s.
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (0.0, 0.0, 0.0))

    attempts = {"n": 0}

    async def _flaky_inner(state, resume, **_kwargs):
        attempts["n"] += 1
        if attempts["n"] <= 3:
            raise HogaplayHTTPError("429 rate limited", status_code=429)
        state.phase = "done"
    monkeypatch.setattr(captures, "_run_capture_inner", _flaky_inner)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    try:
        await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    finally:
        await captures.stop_workers(workers)

    assert attempts["n"] == 4
    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "done"


async def test_done_phase_bumps_estimate_pct_to_100(monkeypatch, tmp_path):
    """Spec §5.5: estimate_pct is clipped to 0–98 during capture; 100 is reserved
    for the terminal `done` state. _run_capture_and_parse must bump it to 100
    when transitioning to done — otherwise the UI shows "done" beside 98%."""
    from hoga.collector.orchestrator import CollectResult

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", lambda: object())

    def _stub_collect(**kwargs):
        return CollectResult(raw_dir=tmp_path, pages_written=10, unique_events=100)

    def _stub_parse(**kwargs):
        return None

    monkeypatch.setattr(captures, "collect_stock_date", _stub_collect)
    monkeypatch.setattr(captures, "parse_stock_date", _stub_parse)

    state = _make_item("x-done")
    state.estimate_pct = 98  # Simulates the cap at the end of capture.

    await captures._run_capture_and_parse(state, resume=False)

    assert state.phase == "done"
    assert state.estimate_pct == 100


async def test_429_backoff_exhausted_marks_failed(monkeypatch, tmp_path):
    """Persistent 429 after all retries → terminal failed."""
    from hoga.collector.client import HogaplayHTTPError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (0.0, 0.0, 0.0))

    async def _always_429(state, resume, **_kwargs):
        raise HogaplayHTTPError("429 rate limited", status_code=429)
    monkeypatch.setattr(captures, "_run_capture_inner", _always_429)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    try:
        await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    finally:
        await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "failed"


# ---------------------------------------------------------------------------
# Task 12: DELETE /api/captures/done — dismiss terminal items
# ---------------------------------------------------------------------------


def test_dismiss_done_clears_terminals_only(monkeypatch, tmp_path):
    app = _build_test_app(monkeypatch, tmp_path)
    monkeypatch.setattr("hoga.api.calendar.trading_days_in_range",
                        lambda s, e: ["20260518", "20260519"])
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.COMPLETE))
    with TestClient(app) as c:
        c.post("/api/captures/items", json={
            "code": "005930", "start_date": "20260518", "end_date": "20260519",
            "force_retry": False,
        })
        # Wait until both items terminate (they skip immediately given COMPLETE).
        for _ in range(40):
            snap = c.get("/api/captures/queue").json()
            if len(snap["done"]) == 2 and not snap["active"]:
                break
            time.sleep(0.05)
        r = c.delete("/api/captures/done")
        assert r.status_code == 204
        snap = c.get("/api/captures/queue").json()
        assert snap["done"] == []


def test_dismiss_done_publishes_capture_dismissed_event(monkeypatch, tmp_path):
    """dismissDone emits CaptureDismissedEvent so the frontend SSE handler can
    drop done rows on the same code path as the Retry flow. Empty _done is a
    no-op (no event published)."""
    from hoga.api.models import CaptureDismissedEvent
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    published: list = []
    monkeypatch.setattr(captures, "_publish_event", lambda e: published.append(e))

    # Seed _done with two terminal items.
    a = _make_item("a", code="005930", date="20260520")
    a.phase = "done"
    b = _make_item("b", code="005930", date="20260521")
    b.phase = "failed"
    captures._done.extend([a, b])

    app = _build_test_app(monkeypatch, tmp_path)
    _no_workers(monkeypatch)
    with TestClient(app) as c:
        r = c.delete("/api/captures/done")
        assert r.status_code == 204

    dismissed = [e for e in published if isinstance(e, CaptureDismissedEvent)]
    assert len(dismissed) == 1
    assert sorted(dismissed[0].item_ids) == ["a", "b"]


def test_dismiss_done_empty_publishes_no_event(monkeypatch, tmp_path):
    """No items in _done → no CaptureDismissedEvent published."""
    from hoga.api.models import CaptureDismissedEvent
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    published: list = []
    monkeypatch.setattr(captures, "_publish_event", lambda e: published.append(e))

    app = _build_test_app(monkeypatch, tmp_path)
    _no_workers(monkeypatch)
    with TestClient(app) as c:
        r = c.delete("/api/captures/done")
        assert r.status_code == 204

    assert not any(isinstance(e, CaptureDismissedEvent) for e in published)


def test_enqueue_range_returns_503_when_kis_holiday_fetch_fails(monkeypatch, tmp_path):
    """When KIS holiday fetch fails, range-based enqueue returns 503 with code."""
    import hoga.api.kis_holidays as kis_holidays_module
    from hoga.api import calendar as calendar_module

    def _raise(year, month):
        raise kis_holidays_module.KisHolidayFetchError("KIS_APP_KEY/KIS_APP_SECRET missing")

    monkeypatch.setattr(kis_holidays_module, "fetch_month_trading_days", _raise)

    # Reset calendar cache so the fetch is attempted.
    calendar_module.reset_cache_for_tests()

    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        response = c.post("/api/captures/items", json={
            "code": "005930",
            "start_date": "20260501",
            "end_date": "20260531",
            "force_retry": False,
        })
        assert response.status_code == 503
        detail = response.json()["detail"]
        assert detail["code"] == "kis_holiday_fetch_failed"
        assert "KIS" in detail["message"] or "kis" in detail["message"].lower()


async def test_cancel_during_429_backoff_aborts_immediately(monkeypatch, tmp_path):
    """Cancel signal during the backoff sleep raises CaptureCancelled and
    the worker marks the item cancelled (NOT failed, NOT done)."""
    from hoga.collector.client import HogaplayHTTPError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    # One backoff slot, long enough that we definitely cancel during it.
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (5.0,))

    async def _always_429(state, resume, **_kwargs):
        raise HogaplayHTTPError("429 rate limited", status_code=429)
    monkeypatch.setattr(captures, "_run_capture_inner", _always_429)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    try:
        # Let the worker pick up the item, fail once, enter the sleep.
        await asyncio.sleep(0.1)
        active = next(iter(captures._active.values()), None)
        assert active is not None, "expected item to be active in backoff sleep"
        assert active.cancel_token is not None
        active.cancel_token.cancel()
        await asyncio.wait_for(captures.wait_drained(), timeout=1.0)
    finally:
        await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "cancelled"


# -----------------------------------------------------------------------------
# Queue manifest persistence — Task 4
# -----------------------------------------------------------------------------


def _read_manifest_json(data_dir):
    p = manifest_path(data_dir)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def test_enqueue_writes_manifest(monkeypatch, tmp_path):
    """Enqueueing items via the route should persist them to .queue.json."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    resp = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    assert resp.status_code == 201
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["schema_version"] == 1
    assert data["paused"] is False
    assert len(data["items"]) == 1
    assert data["items"][0]["code"] == "005930"
    assert data["items"][0]["date"] == "20260520"


def test_cancel_queued_item_updates_manifest(monkeypatch, tmp_path):
    """Cancelling a queued item should remove it from the manifest."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    resp = client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520"], "force_retry": False,
    })
    item_id = resp.json()["enqueued"][0]["item_id"]
    client.post(f"/api/captures/items/{item_id}/cancel")
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["items"] == []  # cancelled item went to _done, which is not persisted


def test_cancel_all_clears_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", FakeHogaplayClient)
    app = FastAPI()
    app.include_router(captures.build_router(
        data_dir=tmp_path, client_factory=FakeHogaplayClient,
    ))
    client = TestClient(app)
    client.post("/api/captures/items", json={
        "code": "005930", "dates": ["20260520", "20260519"], "force_retry": False,
    })
    client.post("/api/captures/cancel-all")
    data = _read_manifest_json(tmp_path)
    assert data is not None
    assert data["items"] == []


def test_persist_no_op_when_data_dir_unset(monkeypatch, tmp_path):
    """When _data_dir is None (test mode without router build), the helper
    must not crash."""
    monkeypatch.setattr(captures, "_data_dir", None)
    captures._persist_queue_locked()  # type: ignore[attr-defined]


def test_reset_state_for_tests_deletes_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    (tmp_path / ".queue.json").write_text(
        '{"schema_version": 1, "paused": false, "items": []}',
        encoding="utf-8",
    )
    captures.reset_state_for_tests()
    assert not (tmp_path / ".queue.json").exists()


def test_publish_event_swallows_serialization_errors(monkeypatch, caplog):
    """ADR-0036 companion: a buggy event model (e.g., a non-JSON-
    serializable field) must NOT propagate into the calling task and
    silently break ALL downstream SSE events. The publish is dropped;
    the cause goes to log.exception."""
    import logging
    from unittest.mock import MagicMock

    # Wire a fake bus + loop so the function reaches the serialize step.
    fake_loop = MagicMock()
    fake_bus = MagicMock()
    monkeypatch.setattr(captures, "_loop", fake_loop)
    monkeypatch.setattr(captures, "_bus", fake_bus)

    class BrokenEvent:
        """Quacks like a BaseModel just enough to enter _publish_event.
        model_dump raises to simulate a serialization bug."""
        def model_dump(self, *args, **kwargs):
            raise TypeError("non-serializable field")

    with caplog.at_level(logging.ERROR, logger="hoga.api.captures"):
        captures._publish_event(BrokenEvent())  # type: ignore[arg-type]

    # Bus must NOT be touched when serialization fails.
    fake_loop.call_soon_threadsafe.assert_not_called()
    # Failure cause is surfaced in the log for ops visibility.
    assert any(
        "failed to serialize" in record.message
        for record in caplog.records
    )


@pytest.mark.asyncio
async def test_attempt_survives_persist_restore_roundtrip(monkeypatch, tmp_path):
    """ADR-0031: the ×N attempt badge is user-visible — it must survive a
    server restart. Persist a state with attempt=5, simulate restart via
    in-memory wipe + _restore_queue_from_manifest, then assert the
    restored state still carries attempt=5."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    captures._queue.clear()
    state = captures.QueueItemState(
        item_id="x-20260526",
        code="003490",
        date="20260526",
        force_retry=True,
        enqueued_at_ms=1700000000000,
        attempt=5,
    )
    captures._queue.append(state)
    # _persist_queue_locked enforces the ADR-0019 lock invariant; mirror
    # the production call sites that hold _lock while calling it.
    async with captures._lock:
        captures._persist_queue_locked()  # type: ignore[attr-defined]

    # Simulate restart: wipe in-memory state, restore from disk.
    captures._queue.clear()
    captures._restore_queue_from_manifest(tmp_path)  # type: ignore[attr-defined]

    assert len(captures._queue) == 1
    restored = captures._queue[0]
    assert restored.attempt == 5
    assert restored.code == "003490"
    assert restored.date == "20260526"
    assert restored.force_retry is True


# ---------------------------------------------------------------------------
# Task 5: UpstreamNoDataError → skipped/no_upstream_data  ADR-0021
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_worker_handles_empty_info_as_skipped_no_upstream_data(monkeypatch, tmp_path):
    """ADR-0021: collect_stock_date raises UpstreamNoDataError → worker writes
    sentinel, cleans stale artifacts, terminates as skipped/no_upstream_data."""
    from hoga.collector.orchestrator import UpstreamNoDataError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_client_factory", lambda: object())
    monkeypatch.setattr(
        "hoga.api.eligibility.check_disk_state",
        lambda *_a, **_k: Classification(state=DiskState.NONE),
    )

    # Pre-create stale artifacts to verify the cleanup branch is exercised.
    raw_dir = tmp_path / "raw" / "20260319" / "003490"
    raw_dir.mkdir(parents=True, exist_ok=True)
    (raw_dir / "info.tsv").write_text("stale", encoding="utf-8")
    (raw_dir / "chart.tsv").write_text("stale", encoding="utf-8")
    (raw_dir / "_progress.json").write_text("{}", encoding="utf-8")

    def _stub_collect(**kwargs):
        raise UpstreamNoDataError(code="003490", date="20260319")

    monkeypatch.setattr(captures, "collect_stock_date", _stub_collect)

    state = _make_item("x-1", code="003490", date="20260319")
    await captures._run_item(state)

    assert state.phase == "skipped"
    assert state.skip_reason == "no_upstream_data"
    assert (raw_dir / ".no_upstream_data").exists()
    assert not (raw_dir / "info.tsv").exists()
    assert not (raw_dir / "chart.tsv").exists()
    assert not (raw_dir / "_progress.json").exists()


# --- Retry endpoint core logic (ADR-0031) ----------------------------------


async def test_retry_items_moves_failed_done_item_to_queue_with_incremented_attempt(
    monkeypatch, tmp_path,
):
    """Happy path: a single failed item_id is removed from _done and a new
    QueueItemState appears in _queue with attempt=prior+1 and the same
    force_retry flag."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    # Seed _done with a failed item.
    failed = _make_item("old-1", code="005930", date="20260520")
    failed.phase = "failed"
    failed.attempt = 1
    captures._done.append(failed)

    result = await captures._retry_items(["old-1"])

    assert result.enqueued[0].attempt == 2
    assert result.enqueued[0].force_retry is False
    assert result.enqueued[0].item_id != "old-1"   # new id
    assert result.skipped == []
    assert len(captures._queue) == 1
    assert captures._queue[0].code == "005930"
    assert captures._queue[0].attempt == 2
    assert all(s.item_id != "old-1" for s in captures._done)
    assert result.dismissed_item_ids == ["old-1"]


async def test_retry_items_preserves_force_retry_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-fr", code="005930", date="20260520")
    failed.phase = "failed"
    failed.force_retry = True
    failed.attempt = 2
    captures._done.append(failed)

    result = await captures._retry_items(["old-fr"])

    assert result.enqueued[0].force_retry is True
    assert result.enqueued[0].attempt == 3


async def test_retry_items_skips_not_found(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    result = await captures._retry_items(["does-not-exist"])
    assert result.enqueued == []
    assert result.skipped == [RetrySkippedRow(item_id="does-not-exist", reason="not_found")]
    assert result.dismissed_item_ids == []


async def test_retry_items_skips_not_failed(monkeypatch, tmp_path):
    """A done-phase item should not be retryable — only `failed`."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    completed = _make_item("done-1", code="005930", date="20260520")
    completed.phase = "done"
    captures._done.append(completed)

    result = await captures._retry_items(["done-1"])

    assert result.enqueued == []
    assert result.skipped == [RetrySkippedRow(item_id="done-1", reason="not_failed")]
    # Done item remains in _done untouched.
    assert any(s.item_id == "done-1" for s in captures._done)


async def test_retry_items_skips_already_in_queue(monkeypatch, tmp_path):
    """(code, date) already in _queue → skipped as already_in_queue."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-2", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)
    # Same (code, date) already in queue from a manual addItems.
    captures._queue.append(_make_item("q-1", code="005930", date="20260520"))

    result = await captures._retry_items(["old-2"])

    assert result.enqueued == []
    assert result.skipped == [RetrySkippedRow(item_id="old-2", reason="already_in_queue")]
    # Failed item is NOT removed when skipped.
    assert any(s.item_id == "old-2" for s in captures._done)


async def test_retry_items_skips_already_running(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("old-3", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)
    active = _make_item("a-1", code="005930", date="20260520")
    active.phase = "capturing"
    captures._active["a-1"] = active

    result = await captures._retry_items(["old-3"])

    assert result.enqueued == []
    assert result.skipped == [RetrySkippedRow(item_id="old-3", reason="already_running")]


async def test_retry_items_bulk_mixed_outcomes(monkeypatch, tmp_path):
    """Three item_ids: one valid failed, one not_found, one not_failed.
    The valid one retries, the other two get distinct skip reasons."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    f1 = _make_item("f1", code="005930", date="20260520")
    f1.phase = "failed"
    f2 = _make_item("d1", code="000660", date="20260521")
    f2.phase = "done"
    captures._done.extend([f1, f2])

    result = await captures._retry_items(["f1", "missing", "d1"])

    assert len(result.enqueued) == 1
    assert result.enqueued[0].code == "005930"
    skip_reasons = {row.item_id: row.reason for row in result.skipped}
    assert skip_reasons == {"missing": "not_found", "d1": "not_failed"}
    assert result.dismissed_item_ids == ["f1"]


async def test_retry_items_dedupes_duplicates_within_batch(monkeypatch, tmp_path):
    """Same item_id passed twice → first retries, second sees not_found
    (already removed from _done)."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("dup", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)

    result = await captures._retry_items(["dup", "dup"])

    assert len(result.enqueued) == 1
    assert result.skipped == [RetrySkippedRow(item_id="dup", reason="not_found")]


async def test_retry_items_persists_manifest_after_mutation(monkeypatch, tmp_path):
    """Sanity-check ADR-0019: a successful Retry persists the manifest."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path, raising=False)
    failed = _make_item("p1", code="005930", date="20260520")
    failed.phase = "failed"
    captures._done.append(failed)

    await captures._retry_items(["p1"])

    from hoga.api.captures_persistence import manifest_path
    path = manifest_path(tmp_path)
    assert path.exists()
    data = json.loads(path.read_text())
    # The new (retry-enqueued) item should be in the manifest's items list,
    # with attempt=2.
    assert any(it["attempt"] == 2 for it in data["items"])


def test_retry_route_returns_201_and_response_shape(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        # Seed: a failed item in _done.
        failed = _make_item("r-1", code="005930", date="20260520")
        failed.phase = "failed"
        captures._done.append(failed)

        r = c.post("/api/captures/items/retry", json={"item_ids": ["r-1"]})
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["code"] == "005930"
        assert body["enqueued"][0]["date"] == "20260520"
        assert body["enqueued"][0]["attempt"] == 2
        assert body["skipped"] == []


def test_retry_route_422_on_empty_item_ids(monkeypatch, tmp_path):
    """RetryRequest declares min_length=1 — FastAPI returns 422."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items/retry", json={"item_ids": []})
        assert r.status_code == 422


def test_retry_route_returns_skipped_reasons(monkeypatch, tmp_path):
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        completed = _make_item("d-1", code="005930", date="20260520")
        completed.phase = "done"
        captures._done.append(completed)

        r = c.post("/api/captures/items/retry", json={
            "item_ids": ["missing-x", "d-1"],
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"] == []
        reasons = {row["item_id"]: row["reason"] for row in body["skipped"]}
        assert reasons == {"missing-x": "not_found", "d-1": "not_failed"}


# --- ADR-0033: addItems phase-aware _done dedupe -----------------------------


def _post_items(c, code: str, dates: list[str], force_retry: bool = False):
    """Convenience: POST /api/captures/items with explicit dates list."""
    return c.post("/api/captures/items", json={
        "code": code, "dates": dates, "force_retry": force_retry,
    })


def _seed_done_item(*, item_id: str, code: str, date: str, phase: CapturePhase,
                    attempt: int = 1, force_retry: bool = False,
                    pause_origin: bool = False):
    s = _make_item(item_id, code=code, date=date)
    s.phase = phase
    s.attempt = attempt
    s.force_retry = force_retry
    s.pause_origin = pause_origin
    captures._done.append(s)
    return s


def test_enqueue_re_enqueues_done_without_force_concept(monkeypatch, tmp_path):
    """done-phase _done item is re-enqueued; worker decides whether disk is complete."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-d", code="005930", date="20260520", phase="done")

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["deduped"] == []
        assert all(s.item_id != "old-d" for s in captures._done)
        assert len(captures._queue) == 1


def test_enqueue_re_enqueues_done_with_force_true_per_adr_0035(monkeypatch, tmp_path):
    """done-phase + force_retry=true → auto re-enqueue (ADR-0035 extension).

    The inventory re-capture UI relies on this branch: a _done row of
    phase=done whose on-disk state is non-complete must be re-queueable
    via force_retry. decide_capture remains the gate for the COMPLETE
    case (see test_decide_capture_complete_skips_with_already_complete_reason
    in test_api_eligibility.py).
    """
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-d", code="005930", date="20260520",
                        phase="done", attempt=1, force_retry=False)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        new = body["enqueued"][0]
        assert new["attempt"] == 2
        assert new["force_retry"] is True
        assert new["item_id"] != "old-d"
        assert body["deduped"] == []
        # Old done row removed; new row in _queue.
        assert all(s.item_id != "old-d" for s in captures._done)
        assert len(captures._queue) == 1
        assert captures._queue[0].attempt == 2
        assert captures._queue[0].force_retry is True


def test_enqueue_re_enqueues_failed_done_regardless_of_force_attempt_increments(
    monkeypatch, tmp_path,
):
    """failed-phase _done → auto re-enqueue with attempt+1 for force_retry=false."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-f", code="005930", date="20260520",
                        phase="failed", attempt=2)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 3
        assert body["enqueued"][0]["item_id"] != "old-f"
        assert body["deduped"] == []
        # Old failed row removed; new row in _queue.
        assert all(s.item_id != "old-f" for s in captures._done)
        assert len(captures._queue) == 1
        assert captures._queue[0].attempt == 3


def test_enqueue_re_enqueues_failed_done_with_force_true(monkeypatch, tmp_path):
    """failed + force_retry=true also auto re-enqueues (same rule)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-ff", code="005930", date="20260520",
                        phase="failed", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["enqueued"][0]["force_retry"] is True


def test_enqueue_re_enqueues_cancelled_done_regardless_of_force(monkeypatch, tmp_path):
    """cancelled-phase _done → auto re-enqueue regardless of force_retry."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-c", code="005930", date="20260520",
                        phase="cancelled", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["deduped"] == []
        assert all(s.item_id != "old-c" for s in captures._done)


def test_enqueue_re_enqueues_skipped_without_force_concept(monkeypatch, tmp_path):
    """skipped + force_retry=false still re-enqueues; retry cap is the only guard."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-s", code="005930", date="20260520",
                        phase="skipped", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["deduped"] == []
        assert all(s.item_id != "old-s" for s in captures._done)


def test_enqueue_re_enqueues_skipped_with_force_true(monkeypatch, tmp_path):
    """skipped + force_retry=true → auto re-enqueue (sentinel will be deleted by worker)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-sk", code="005930", date="20260520",
                        phase="skipped", attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=True)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        assert body["enqueued"][0]["force_retry"] is True
        assert all(s.item_id != "old-sk" for s in captures._done)


def test_enqueue_publishes_capture_dismissed_event_for_auto_reenqueued_items(
    monkeypatch, tmp_path,
):
    """One CaptureDismissedEvent listing every old item_id, published before CaptureQueuedEvent."""
    from hoga.api.models import CaptureDismissedEvent, CaptureQueuedEvent
    _no_workers(monkeypatch)
    published: list = []
    monkeypatch.setattr(captures, "_publish_event", lambda e: published.append(e))

    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="f1", code="005930", date="20260520", phase="failed")
        _seed_done_item(item_id="c1", code="005930", date="20260521", phase="cancelled")

        r = _post_items(c, "005930", ["20260520", "20260521"], force_retry=False)
        assert r.status_code == 201, r.text

    dismissed = [e for e in published if isinstance(e, CaptureDismissedEvent)]
    queued = [e for e in published if isinstance(e, CaptureQueuedEvent)]
    assert len(dismissed) == 1
    assert sorted(dismissed[0].item_ids) == ["c1", "f1"]
    assert len(queued) == 1
    # Order: dismissed event must come before queued event in publish stream.
    dismissed_pos = published.index(dismissed[0])
    queued_pos = published.index(queued[0])
    assert dismissed_pos < queued_pos


def test_enqueue_re_enqueues_pause_origin_cancelled_via_cancelled_rule(
    monkeypatch, tmp_path,
):
    """pause_origin=True + phase=cancelled is just a cancelled item — auto re-enqueued like any other."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="po-1", code="005930", date="20260520",
                        phase="cancelled", pause_origin=True, attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["enqueued"][0]["attempt"] == 2
        # New item starts with fresh pause_origin (default False) regardless of old.
        assert body["enqueued"][0]["pause_origin"] is False
        # Old pause_origin item removed from _done.
        assert all(s.item_id != "po-1" for s in captures._done)


def test_enqueue_uses_request_force_retry_not_old_item_force_retry(
    monkeypatch, tmp_path,
):
    """Old item had force_retry=True, request has force_retry=False → new force_retry == False."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="old-fr", code="005930", date="20260520",
                        phase="failed", force_retry=True, attempt=1)

        r = _post_items(c, "005930", ["20260520"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["enqueued"][0]["force_retry"] is False  # request wins


# --- ADR-0020 strict-first/lenient-fallback parse path ---------------------


@pytest.mark.asyncio
async def test_parse_trade_validation_error_retries_lenient_and_surfaces_warnings(
    monkeypatch, tmp_path,
):
    """Reproduces the 489790/20260224 cum_vol-rebase scenario: strict parse
    raises TradeValidationError, the wrapper retries with lenient=True, and the
    item finalizes as 'done' with the meta.json invariants attached to
    state.warnings (visible on the SSE finished event and snapshot)."""
    from pathlib import Path

    from hoga.collector.orchestrator import CollectResult
    from hoga.tables.trades import TradeValidationError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))

    # Stub the collector so we don't actually fetch anything.
    monkeypatch.setattr(captures, "_require_client_factory", lambda: (lambda: object()))
    def _fake_collect(**_kw) -> CollectResult:
        return CollectResult(raw_dir=Path(tmp_path), pages_written=1384,
                              unique_events=129067, abort_reason=None)
    monkeypatch.setattr(captures, "collect_stock_date", _fake_collect)

    call_modes: list[bool] = []
    def _fake_parse(*, code, date, data_dir, lenient):
        call_modes.append(lenient)
        if not lenient:
            raise TradeValidationError(
                "cum_vol decreased at ts_ms=95421384: 3086391 -> 3085866"
            )
        # Lenient succeeds — caller will read meta.json next.
        return Path(data_dir) / "parquet" / date / code
    monkeypatch.setattr(captures, "parse_stock_date", _fake_parse)

    captures._queue.append(_make_item("anomaly-1", code="489790", date="20260224"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    # Both attempts happened, in the right order (strict first, then lenient).
    assert call_modes == [False, True]

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    item = snap.done[0]
    assert item.phase == "done"
    assert item.error is None
    assert item.warnings is not None
    assert len(item.warnings) == 1
    # Synthesized from the strict-mode TradeValidationError, not pulled from
    # meta.json — so unrelated archival-only invariants don't bleed in.
    assert item.warnings[0].invariant_id == "series.cum_vol_monotonic"
    assert item.warnings[0].severity == "warn"
    assert "cum_vol decreased at ts_ms=95421384" in item.warnings[0].message


@pytest.mark.asyncio
async def test_parse_clean_capture_leaves_warnings_unset(monkeypatch, tmp_path):
    """Inverse case: strict parse succeeds, warnings stays None."""
    from pathlib import Path

    from hoga.collector.orchestrator import CollectResult

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: Classification(state=DiskState.NONE))
    monkeypatch.setattr(captures, "_require_client_factory", lambda: (lambda: object()))
    monkeypatch.setattr(captures, "collect_stock_date",
                        lambda **_kw: CollectResult(raw_dir=Path(tmp_path),
                                                     pages_written=10,
                                                     unique_events=100,
                                                     abort_reason=None))
    monkeypatch.setattr(captures, "parse_stock_date",
                        lambda **_kw: Path(tmp_path))

    # If the warning synthesizer is called, this test fails loudly — the
    # strict path must skip the lenient retry entirely.
    def _boom(*_a, **_k):
        raise AssertionError("_validation_error_to_warning called on clean capture")
    monkeypatch.setattr(captures, "_validation_error_to_warning", _boom)

    captures._queue.append(_make_item("clean-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.done[0].phase == "done"
    assert snap.done[0].warnings is None


def test_enqueue_response_includes_auto_reenqueued_items_in_enqueued_list(
    monkeypatch, tmp_path,
):
    """Response body's `enqueued` array contains BOTH fresh items (attempt=1) and auto-retried items (attempt>1)."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        _seed_done_item(item_id="ret-1", code="005930", date="20260520",
                        phase="failed", attempt=1)
        # 20260521 is fresh (no _done entry)

        r = _post_items(c, "005930", ["20260520", "20260521"], force_retry=False)
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 2
        by_date = {it["date"]: it for it in body["enqueued"]}
        assert by_date["20260520"]["attempt"] == 2  # auto-retried
        assert by_date["20260521"]["attempt"] == 1  # fresh
        assert body["deduped"] == []


def test_enqueue_items_core_is_module_level_and_callable():
    """ADR-0034: scheduler.py must be able to import enqueue_items_core
    without going through the router."""
    from hoga.api import captures as caps
    assert hasattr(caps, "enqueue_items_core"), \
        "enqueue_items_core must be module-level for ADR-0034"
    import asyncio
    assert asyncio.iscoroutinefunction(caps.enqueue_items_core)


@pytest.mark.asyncio
async def test_finalize_item_done_bumps_watchlist_last_success(tmp_path):
    """The _finalize_item hook must call watchlist.bump_last_success
    when phase is 'done' AND the on-disk classification is COMPLETE.
    Gating on disk_state (not just phase) is what keeps /watchlist in
    agreement with /capture — see test_api_watchlist_marker_sync."""
    from unittest.mock import patch, AsyncMock
    from hoga.api import captures, watchlist
    captures.reset_state_for_tests()
    captures._data_dir = tmp_path
    # Register the Code in the Watchlist so the bump has somewhere to land (v3:
    # membership defines the entry — add into a freshly created folder).
    _fid = (await watchlist.create_folder(tmp_path, name="기본")).id
    await watchlist.add_member(tmp_path, code="005930", name="삼성전자",
                               today_kst_date="20260526", folder_id=_fid)
    # Disk fixture: a COMPLETE Stock-Date so the gate lets the bump through.
    meta = tmp_path / "parquet" / "20260526" / "005930" / "meta.json"
    meta.parent.mkdir(parents=True, exist_ok=True)
    meta.write_text(json.dumps({
        "collection_complete": True,
        "is_partial": False,
        "regular_session_open_ms": 90_000_000,
        "regular_session_close_ms": 153_100_000,
    }))

    state = captures.QueueItemState(
        item_id="x", code="005930", date="20260526",
        force_retry=False, enqueued_at_ms=0, attempt=1,
    )
    state.phase = "done"

    with patch("hoga.api.captures.watchlist.bump_last_success",
               new_callable=AsyncMock) as bump:
        await captures._finalize_item(state)

    bump.assert_awaited_once_with(tmp_path, code="005930", date="20260526")


@pytest.mark.asyncio
async def test_finalize_item_failed_does_not_bump(tmp_path):
    from unittest.mock import patch, AsyncMock
    from hoga.api import captures
    captures.reset_state_for_tests()
    captures._data_dir = tmp_path
    state = captures.QueueItemState(
        item_id="x", code="005930", date="20260526",
        force_retry=False, enqueued_at_ms=0, attempt=1,
    )
    state.phase = "failed"

    with patch("hoga.api.captures.watchlist.bump_last_success",
               new_callable=AsyncMock) as bump:
        await captures._finalize_item(state)

    bump.assert_not_awaited()


# ----- ADR-0042: fail_streak guard -----------------------------------------
# Guard runs INSIDE _lock + BEFORE Q15 Layer 1 / ADR-0033 _done dedupe. A
# (Code, Stock-Date) with fail_streak >= ATTEMPT_CAP is reported on
# EnqueueResponse.blocked and excluded from further processing. force_retry
# does NOT bypass the gate — that's the whole point.


def test_enqueue_pair_at_streak_4_is_accepted(monkeypatch, tmp_path):
    """One below the cap → still accepted (cap is exclusive at 5)."""
    _no_workers(monkeypatch)
    captures._fail_streaks["005930|20260520"] = 4
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert len(body["enqueued"]) == 1
        assert body["blocked"] == []


def test_enqueue_pair_at_streak_5_is_blocked(monkeypatch, tmp_path):
    """At the cap → blocked, no enqueue, HTTP 409 (whole request rejected)."""
    _no_workers(monkeypatch)
    captures._fail_streaks["005930|20260520"] = 5
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 409
        body = r.json()
        assert body["enqueued"] == []
        assert len(body["blocked"]) == 1
        b = body["blocked"][0]
        assert b == {
            "code": "005930", "date": "20260520",
            "fail_streak": 5, "reason": "fail_streak_exceeded",
        }


def test_enqueue_force_retry_does_NOT_bypass_guard(monkeypatch, tmp_path):
    """force_retry controls disk-cache bypass; it does NOT override the cap.
    This is the whole point of ADR-0042 — without it, inventory Re-capture
    with force_retry could keep hitting hogaplay indefinitely on
    no_upstream_data symbols (ADR-0021 case)."""
    _no_workers(monkeypatch)
    captures._fail_streaks["005930|20260520"] = 5
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": True,
        })
        assert r.status_code == 409
        body = r.json()
        assert body["enqueued"] == []
        assert len(body["blocked"]) == 1


def test_enqueue_mixed_some_accepted_some_blocked(monkeypatch, tmp_path):
    """Partial-success: one accepted, one blocked, in the same request."""
    _no_workers(monkeypatch)
    captures._fail_streaks["005930|20260520"] = 5
    # 20260521 has no counter → accepted.
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520", "20260521"], "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert {it["date"] for it in body["enqueued"]} == {"20260521"}
        assert {b["date"] for b in body["blocked"]} == {"20260520"}


def test_enqueue_guard_runs_before_adr_0033_done_dedupe(monkeypatch, tmp_path):
    """If a pair is BOTH blocked AND in _done(phase=failed) — which ADR-0033
    would normally auto-re-enqueue — the response must say BLOCKED, not
    re-enqueued and not deduped. The guard runs first."""
    _no_workers(monkeypatch)
    captures._fail_streaks["005930|20260520"] = 5
    # Seed _done with a failed entry that ADR-0033 would re-enqueue.
    captures._done.append(QueueItemState(
        item_id="prev", code="005930", date="20260520",
        force_retry=False, enqueued_at_ms=0, phase="failed",
    ))
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        body = r.json()
        assert body["enqueued"] == []
        assert body["deduped"] == []
        assert len(body["blocked"]) == 1
        assert body["blocked"][0]["reason"] == "fail_streak_exceeded"


def test_enqueue_blocked_default_field_for_unaffected_paths(monkeypatch, tmp_path):
    """When no pair is blocked, the response still contains blocked=[]."""
    _no_workers(monkeypatch)
    app = _build_test_app(monkeypatch, tmp_path)
    with TestClient(app) as c:
        r = c.post("/api/captures/items", json={
            "code": "005930", "dates": ["20260520"], "force_retry": False,
        })
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["blocked"] == []


def test_apply_progress_threads_upstream_health_telemetry():
    """Upstream-health fields must flow ProgressEvent → state → wire progress.

    This is the explicit-enumeration seam (evt → _apply_progress → to_progress)
    where a new field silently drops if any hop is missed — the UI badge would
    just never render, and no compiler catches it (ADR-0004 hand-mirror).
    """
    from hoga.collector.orchestrator import ProgressEvent
    from hoga.api.timeenc import HogaMs

    state = QueueItemState(
        item_id="x-20260709",
        code="005930",
        date="20260709",
        force_retry=False,
        enqueued_at_ms=1_700_000_000_000,
        started_at_ms=1_700_000_001_000,
        phase="capturing",
    )
    evt = ProgressEvent(
        code="005930",
        date="20260709",
        pages_done=42,
        events_seen=1000,
        frontier=HogaMs(90000000),
        recent_http_p50_ms=612.5,
        throttled_pages=3,
    )
    captures._apply_progress(state, evt)  # type: ignore[attr-defined]

    assert state.recent_http_p50_ms == 612.5
    assert state.throttled_pages == 3
    progress = state.to_progress()
    assert progress is not None
    assert progress.recent_http_p50_ms == 612.5
    assert progress.throttled_pages == 3
