"""End-to-end: enqueue → kill workers → restore → workers drain. Task 6."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from hoga.api import captures
from hoga.api.app import create_app
from hoga.api.captures_fake import FakeHogaplayClient


@pytest.fixture(autouse=True)
def _reset(tmp_path):
    captures._data_dir = tmp_path
    captures._client_factory = FakeHogaplayClient
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


async def test_restore_after_simulated_restart_drains_queue(tmp_path: Path, monkeypatch):
    """1. Enqueue 2 items.
    2. Stop workers (simulates server shutdown leaving manifest behind).
    3. Reset in-memory state but keep manifest on disk.
    4. Restore from manifest.
    5. Start workers — they should drain the restored queue.
    """
    workers = captures.start_workers(n=2)
    try:
        captures._queue.append(captures.QueueItemState(
            item_id="restore-test-1", code="005930", date="20260520",
            force_retry=False, enqueued_at_ms=1700000000000,
        ))
        captures._queue.append(captures.QueueItemState(
            item_id="restore-test-2", code="005930", date="20260519",
            force_retry=False, enqueued_at_ms=1700000000001,
        ))
        async with captures._lock:
            captures._persist_queue_locked()
    finally:
        await captures.stop_workers(workers)

    manifest_data = json.loads((tmp_path / ".queue.json").read_text(encoding="utf-8"))
    assert len(manifest_data["items"]) == 2

    captures._queue.clear()
    captures._active.clear()
    captures._done.clear()
    captures._inflight_paths.clear()
    captures._queue_paused = False

    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert [i.item_id for i in snap.queued] == ["restore-test-1", "restore-test-2"]

    async def _stub_run_item(state):
        state.phase = "done"
    # Use monkeypatch (not direct module write) so the stub auto-reverts at
    # teardown and does not leak _run_item into other test modules.
    monkeypatch.setattr(captures, "_run_item", _stub_run_item)

    workers = captures.start_workers(n=2)
    try:
        await asyncio.wait_for(captures.wait_drained(), timeout=5.0)
    finally:
        await captures.stop_workers(workers)

    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert len(snap.done) == 2


def test_lifespan_restores_manifest_at_startup(tmp_path, monkeypatch):
    """Create a FastAPI app with a pre-seeded manifest, start the lifespan,
    and confirm the queue is populated before any HTTP request fires."""
    (tmp_path / ".queue.json").write_text(json.dumps({
        "schema_version": 1,
        "paused": False,
        "items": [
            {"item_id": "lifespan-test-1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1700000000000,
             "pause_origin": False},
        ],
    }), encoding="utf-8")

    monkeypatch.setenv("HOGA_ENABLE_TEST_ENDPOINTS", "1")
    app = create_app(tmp_path)
    with TestClient(app) as client:
        resp = client.get("/api/captures/queue")
        assert resp.status_code == 200
        snap = resp.json()
        all_items = snap["queued"] + snap["active"] + snap["done"]
        assert any(i["item_id"] == "lifespan-test-1" for i in all_items)
