import asyncio
import datetime as dt
import threading
from types import SimpleNamespace

import httpx
from fastapi import FastAPI

from hoga.api import screener_history_jobs as jobs
from hoga.api.models import ScanRequest
from hoga.api.screener_history_state import JobCheckpoint, create_job
from hoga.api.screener_history_storage import CommitResult


def setup_job(path, monkeypatch):
    jobs.build_router(path)
    job = create_job(ScanRequest(conditions=[]), ['005930'])
    jobs._save(path, job)
    monkeypatch.setattr(jobs, 'recover_publication', lambda _: None)
    monkeypatch.setattr(jobs.coverage, 'evaluate', lambda *args: SimpleNamespace(
        collection_starts={'005930': dt.date(2026, 9, 1)},
    ))
    return job


async def test_shutdown_cancels_fetch_and_persists_interrupted(tmp_path, monkeypatch):
    job = setup_job(tmp_path, monkeypatch)
    entered = asyncio.Event()

    async def fetch(*args):
        entered.set()
        await asyncio.Event().wait()

    task = asyncio.create_task(jobs.run_job(tmp_path, job, fetch))
    jobs._tasks[str(tmp_path)] = task
    await entered.wait()
    await jobs.shutdown_jobs(tmp_path)
    saved = JobCheckpoint(tmp_path).load()
    assert task.cancelled()
    assert saved.status == 'interrupted' and saved.current_code is None
    assert str(tmp_path) not in jobs._tasks


async def test_shutdown_waits_for_started_publication_thread(tmp_path, monkeypatch):
    job = setup_job(tmp_path, monkeypatch)
    entered, finished = asyncio.Event(), threading.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    monkeypatch.setattr(jobs, '_COMMIT_BATCH', 1)

    def commit(*args):
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(5), 'test failed to release publication'
        finished.set()
        return CommitResult(written_rows=1)

    async def fetch(*args):
        return (object(), object())

    monkeypatch.setattr(jobs, 'commit_verified', commit)
    task = asyncio.create_task(jobs.run_job(tmp_path, job, fetch))
    jobs._tasks[str(tmp_path)] = task
    await entered.wait()
    shutdown = asyncio.create_task(jobs.shutdown_jobs(tmp_path))
    try:
        while not task.cancelling():
            await asyncio.sleep(0)
        assert not shutdown.done()
        assert not finished.is_set()
    finally:
        release.set()
        await shutdown
    assert finished.is_set()
    assert JobCheckpoint(tmp_path).load().status == 'interrupted'


async def test_shutdown_before_first_instruction_and_admission_closed(tmp_path):
    app = FastAPI()
    app.include_router(jobs.build_router(tmp_path))
    job = create_job(ScanRequest(conditions=[]), ['005930'])
    jobs._save(tmp_path, job)
    started = False

    async def queued():
        nonlocal started
        started = True

    jobs._tasks[str(tmp_path)] = asyncio.create_task(queued())
    other = asyncio.create_task(asyncio.Event().wait())
    jobs._tasks['other-data-dir'] = other
    try:
        await jobs.shutdown_jobs(tmp_path)
        assert not started
        assert not other.done()
        assert JobCheckpoint(tmp_path).load().status == 'interrupted'
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/history/jobs', json={'conditions': []})
        assert response.status_code == 503
    finally:
        other.cancel()
        await asyncio.gather(other, return_exceptions=True)
        jobs._tasks.pop('other-data-dir')


async def test_checkpoint_failure_does_not_prevent_remaining_app_teardown(tmp_path, monkeypatch, caplog):
    jobs.build_router(tmp_path)
    job = create_job(ScanRequest(conditions=[]), ['005930'])
    jobs._save(tmp_path, job)

    def fail(*args):
        raise OSError('synthetic full disk')

    monkeypatch.setattr(jobs, '_save', fail)
    await jobs.shutdown_jobs(tmp_path)
    assert 'historical shutdown checkpoint failed' in caplog.text
