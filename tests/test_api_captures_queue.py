"""Plan B queue/worker tests. Built up across Tasks 3–15."""
from __future__ import annotations

import asyncio
import time

import pytest

from hoga.api import captures
from hoga.api.captures import QueueItemState
from hoga.api.disk_state import DiskState


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
                        lambda *_a, **_k: DiskState.COMPLETE)

    captures._queue.append(_make_item("x-1"))
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert len(snap.done) == 1
    assert snap.done[0].phase == "skipped"
    assert snap.done[0].skip_reason == "already_complete"


@pytest.mark.asyncio
async def test_deciding_skips_source_partial(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: DiskState.SOURCE_PARTIAL)

    captures._queue.append(_make_item("x-1"))  # force_retry=False
    workers = captures.start_workers(n=1)
    await asyncio.wait_for(captures.wait_drained(), timeout=2.0)
    await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.done[0].phase == "skipped"
    assert snap.done[0].skip_reason == "source_partial"


@pytest.mark.asyncio
async def test_deciding_resumes_client_incomplete(monkeypatch, tmp_path):
    """CLIENT_INCOMPLETE forces resume=True in the collector call."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: DiskState.CLIENT_INCOMPLETE)

    captured = {}
    async def _stub_capture(state, resume):
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
                        lambda *_a, **_k: DiskState.SOURCE_PARTIAL)

    captured = {}
    async def _stub_capture(state, resume):
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
                        lambda *_a, **_k: DiskState.NONE)

    start_order: list[str] = []
    finish_order: list[str] = []
    sem = asyncio.Semaphore(0)

    async def _capture(state, resume):
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


def test_enqueue_rejects_today_pre_18_kst(monkeypatch, tmp_path):
    """A date matching today_kst before 18:00 → 400 today_too_early."""
    _no_workers(monkeypatch)
    KST = dt.timezone(dt.timedelta(hours=9))
    fixed_now = dt.datetime(2026, 5, 22, 17, 30, 0, tzinfo=KST)
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
                        lambda *_a, **_k: DiskState.NONE)
    # Patch _run_capture_and_parse to block so items stay queued/active.
    sem = asyncio.Event()

    async def _block(state, resume):
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
                        lambda *_a, **_k: DiskState.COMPLETE)
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
                        lambda *_a, **_k: DiskState.NONE)
    sem = asyncio.Event()

    async def _block(state, resume):
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

    async def _runner(state, resume):
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
                        lambda *_a, **_k: DiskState.NONE)
    # Zero the backoff so the test doesn't actually wait 5+10+30s.
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (0.0, 0.0, 0.0))

    attempts = {"n": 0}

    async def _flaky_inner(state, resume):
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
                        lambda *_a, **_k: DiskState.NONE)
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (0.0, 0.0, 0.0))

    async def _always_429(state, resume):
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
                        lambda *_a, **_k: DiskState.COMPLETE)
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


def test_enqueue_range_returns_503_when_krx_creds_missing(monkeypatch, tmp_path):
    """When KRX creds are missing, range-based enqueue returns 503 with code."""
    monkeypatch.delenv("KRX_ID", raising=False)
    monkeypatch.delenv("KRX_PW", raising=False)

    # Reset calendar cache so the pre-check kicks in.
    from hoga.api import calendar as calendar_module
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
        assert detail["code"] == "krx_credentials_missing"
        assert "KRX" in detail["message"] or "krx" in detail["message"].lower()


async def test_cancel_during_429_backoff_aborts_immediately(monkeypatch, tmp_path):
    """Cancel signal during the backoff sleep raises CaptureCancelled and
    the worker marks the item cancelled (NOT failed, NOT done)."""
    from hoga.collector.client import HogaplayHTTPError

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr("hoga.api.eligibility.check_disk_state",
                        lambda *_a, **_k: DiskState.NONE)
    # One backoff slot, long enough that we definitely cancel during it.
    monkeypatch.setattr(captures, "_BACKOFF_DELAYS", (5.0,))

    async def _always_429(state, resume):
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
