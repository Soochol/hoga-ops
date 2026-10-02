"""Real flock contention, late restore, failure and lifecycle fencing."""
import asyncio
import json
import sys

import pytest
from fastapi.testclient import TestClient

from hoga.api import captures, ownership
from hoga.api.capture_queue_runtime import CaptureQueueRuntime


@pytest.fixture(autouse=True)
def reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


async def test_real_process_handoff_restores_latest_manifest_once(tmp_path):
    child = await asyncio.create_subprocess_exec(
        sys.executable, "-c",
        "import fcntl,sys; f=open(sys.argv[1],'w'); "
        "fcntl.flock(f,fcntl.LOCK_EX); print('owned',flush=True); "
        "sys.stdin.readline(); f.close()",
        str(ownership.lock_path(tmp_path)),
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
    )
    restored = []
    ready = asyncio.Event()

    def activate(manifest):
        restored.append(manifest)
        ready.set()

    runtime = CaptureQueueRuntime(tmp_path, disabled=False, activate=activate)
    supervisor = None
    try:
        assert await asyncio.wait_for(child.stdout.readline(), 10) == b"owned\n"
        await runtime.attempt()
        assert runtime.state == "contended"
        assert not runtime.ready and restored == []
        # The current owner can change the manifest after the failed boot.
        (tmp_path / ".queue.json").write_text(json.dumps({
            "schema_version": 1, "paused": True, "items": [],
            "fail_streaks": {"005930:20260520": 2},
        }))
        child.stdin.write(b"release\n")
        await child.stdin.drain()
        await asyncio.wait_for(child.wait(), 10)
        # No manual second attempt: the same lifespan supervisor takes over.
        supervisor = asyncio.create_task(runtime.run())
        await asyncio.wait_for(ready.wait(), 5)
        await runtime.attempt()
        assert runtime.ready and runtime.epoch == 1
        assert len(restored) == 1 and restored[0].paused
        assert restored[0].fail_streaks == {"005930:20260520": 2}
    finally:
        if supervisor is not None:
            supervisor.cancel()
            with pytest.raises(asyncio.CancelledError):
                await supervisor
        ownership.release("queue")
        if child.returncode is None:
            child.kill()
            await child.wait()


async def test_corrupt_manifest_fails_closed_and_is_not_overwritten(tmp_path):
    path = tmp_path / ".queue.json"
    path.write_text("{broken")
    activated = []
    runtime = CaptureQueueRuntime(tmp_path, disabled=False, activate=activated.append)
    await runtime.attempt()
    assert runtime.state == "failed" and "restoring" in runtime.error
    assert not runtime.ready and activated == []
    assert not ownership.is_owned("queue")
    assert path.read_text() == "{broken"
    assert list(tmp_path.glob("*.corrupt-*")) == []


async def test_cancel_restore_releases_acquired_fd(monkeypatch, tmp_path):
    import hoga.api.capture_queue_runtime as module

    entered, release = asyncio.Event(), asyncio.Event()

    async def read(*args, **kwargs):
        entered.set()
        await release.wait()

    monkeypatch.setattr(module.asyncio, "to_thread", read)
    runtime = CaptureQueueRuntime(tmp_path, disabled=False, activate=lambda manifest: None)
    task = asyncio.create_task(runtime.attempt())
    await entered.wait()
    assert ownership.is_owned("queue") and not runtime.ready
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert not ownership.is_owned("queue")
    lock = ownership.try_acquire_queue_ownership(tmp_path)
    assert lock is not None
    lock.release()


async def test_disabled_runtime_never_contends(monkeypatch, tmp_path):
    def forbidden(*args, **kwargs):
        raise AssertionError("disabled instance attempted flock")

    monkeypatch.setattr(ownership, "try_acquire_queue_ownership", forbidden)
    runtime = CaptureQueueRuntime(tmp_path, disabled=True, activate=forbidden)
    await runtime.attempt()
    assert runtime.state == "disabled" and runtime.attempts == 0


async def test_production_runtime_replaces_stale_queue_and_stops_mutations(tmp_path, monkeypatch):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    (tmp_path / ".queue.json").write_text(json.dumps({
        "schema_version": 1, "paused": True,
        "items": [{"item_id": "fresh", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False}],
    }))
    task = await captures.start_capture_runtime(tmp_path)
    try:
        assert captures.queue_owned()
        assert [item.item_id for item in captures._queue] == ["fresh"]
        await captures._queue_runtime.attempt()
        assert [item.item_id for item in captures._queue] == ["fresh"]
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        # A task cancelled before its first scheduler turn may not enter run's
        # finally. Lifespan admission is stopped explicitly before teardown.
    finally:
        await captures.stop_workers(captures._workers)
        captures._workers = []
        ownership.release("queue")
        captures.clear_capture_runtime()


async def test_empty_directory_can_become_ready(tmp_path):
    restored = []
    runtime = CaptureQueueRuntime(tmp_path, disabled=False, activate=restored.append)
    try:
        await runtime.attempt()
        assert runtime.ready and restored[0].items == [] and not restored[0].paused
    finally:
        ownership.release("queue")


async def test_health_stays_503_during_restore_even_with_lock_and_no_dead_tasks(tmp_path, monkeypatch):
    import hoga.api.capture_queue_runtime as module
    from hoga.api.app import create_app

    entered, release = asyncio.Event(), asyncio.Event()

    async def read(*args, **kwargs):
        entered.set()
        await release.wait()

    monkeypatch.setattr(module.asyncio, "to_thread", read)
    runtime = CaptureQueueRuntime(tmp_path, disabled=False, activate=lambda manifest: None)
    monkeypatch.setattr(captures, "_queue_runtime", runtime)
    app = create_app(tmp_path)

    class Tasks:
        def supervised_task_health(self):
            return []

    app.state.startup_runtime = Tasks()
    task = asyncio.create_task(runtime.attempt())
    await entered.wait()
    try:
        client = TestClient(app)  # no lifespan: only the HTTP serialization boundary
        response = client.get("/health?deep=1")
        assert response.status_code == 503
        assert response.json()["queue"]["owned"] is True
        assert response.json()["queue"]["state"] == "restoring"
        assert response.json()["dead_tasks"] == []
        release.set()
        await task
        response = client.get("/health?deep=1")
        assert response.status_code == 200 and response.json()["queue"]["ready"]
    finally:
        release.set()
        await task
        ownership.release("queue")


async def test_shutdown_blocks_mutations_but_preserves_owned_manifest_write(tmp_path, monkeypatch):
    from hoga.api.captures_persistence import load_manifest

    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "start_workers", lambda: [])
    task = await captures.start_capture_runtime(tmp_path)
    try:
        captures.begin_capture_shutdown()
        assert not captures.queue_owned() and ownership.is_owned("queue")
        async with captures._lock:
            captures._queue_paused = True
            captures._persist_queue_locked()
        assert load_manifest(tmp_path).paused
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        ownership.release("queue")
        captures.clear_capture_runtime()


async def test_worker_start_failure_releases_ownership_and_preserves_manifest(tmp_path, monkeypatch):
    path = tmp_path / ".queue.json"
    original = json.dumps({"schema_version": 1, "paused": True, "items": []})
    path.write_text(original)

    def fail():
        raise RuntimeError("worker creation failed")

    monkeypatch.setattr(captures, "start_workers", fail)
    task = await captures.start_capture_runtime(tmp_path)
    try:
        assert captures.queue_ownership_state()["state"] == "failed"
        assert not ownership.is_owned("queue") and not captures.queue_owned()
        assert captures._workers == [] and path.read_text() == original
    finally:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        captures.clear_capture_runtime()
