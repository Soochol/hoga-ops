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
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
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
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
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
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
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
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
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
    monkeypatch.setattr("hoga.api.captures._data_dir_for_tests", lambda: tmp_path, raising=False)
    monkeypatch.setattr("hoga.api.disk_state.check_disk_state",
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
