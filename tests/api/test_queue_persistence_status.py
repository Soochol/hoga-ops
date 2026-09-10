import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import captures, captures_persistence
from hoga.api.models import QueueSnapshot


@pytest.fixture
def queue_state(tmp_path, monkeypatch):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_lock", asyncio.Lock())
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


async def test_save_failure_preserves_memory_exposes_wire_status_and_recovers(queue_state, tmp_path, monkeypatch):
    events = []
    monkeypatch.setattr(captures, "_publish_event", events.append)
    async with captures._lock:
        captures._persist_queue_locked()
    last_saved = captures.get_queue_snapshot().last_persisted_at_ms
    assert last_saved is not None
    write = captures_persistence.atomic_write_json

    def fail(*args, **kwargs):
        raise OSError("synthetic full disk")

    monkeypatch.setattr(captures_persistence, "atomic_write_json", fail)
    async with captures._lock:
        captures._queue_paused = True
        captures._persist_queue_locked()
        captures._persist_queue_locked()
    app = FastAPI()
    app.get("/queue", response_model=QueueSnapshot)(captures.get_queue_snapshot)
    payload = TestClient(app).get("/queue").json()
    assert payload["paused"] is True
    assert payload["persistence_degraded"] is True
    assert payload["last_persisted_at_ms"] == last_saved
    assert len(events) == 1  # Repeated failures don't flood subscribers.
    assert events[0].model_dump(mode="json")["type"] == "capture_queue_persistence"
    monkeypatch.setattr(captures_persistence, "atomic_write_json", write)
    # One retry tick; then stop the lifespan task without a wall-clock sleep.
    monkeypatch.setattr(captures.asyncio, "sleep", AsyncMock(side_effect=[None, asyncio.CancelledError]))
    with pytest.raises(asyncio.CancelledError):
        await captures.retry_queue_persistence()
    assert captures_persistence.load_manifest(tmp_path).paused is True
    assert captures.get_queue_snapshot().persistence_degraded is False
    assert len(events) == 2 and events[-1].persistence_degraded is False


async def test_non_owner_cannot_retry_manifest_write(queue_state, monkeypatch):
    monkeypatch.setattr(captures, "queue_owned", lambda: False)
    monkeypatch.setattr(captures, "_persistence_degraded", True)
    writes = []
    monkeypatch.setattr(captures, "save_manifest", lambda *args: writes.append(args))
    async with captures._lock:
        captures._persist_queue_locked()
    assert not writes
