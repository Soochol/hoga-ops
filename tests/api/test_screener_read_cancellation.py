import asyncio
import threading

import pytest

from hoga.api import screener_series_runner as runner, screener_snapshot_cache as snapshots
from hoga.api.read_shutdown import ReadInterrupted, ReadOperation, ReadWork, run_read_sync


@pytest.mark.parametrize('cancel_owner', [False, True])
async def test_shared_snapshot_loader_failure_preserves_other_readers(monkeypatch, cancel_owner):
    cache = snapshots.SnapshotCache()
    owner_stop, other_stop = ReadOperation(ReadWork()), ReadOperation(ReadWork())
    started, waiting = asyncio.Event(), asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    original_wait = cache._wait_entry
    loads = []

    def wait(*args):
        loop.call_soon_threadsafe(waiting.set)
        return original_wait(*args)

    monkeypatch.setattr(cache, '_wait_entry', wait)

    def first_load():
        loop.call_soon_threadsafe(started.set)
        assert release.wait(5)
        owner_stop.checkpoint()
        raise TimeoutError('provider timeout')

    def second_load():
        loads.append(True)
        return 42

    first = asyncio.create_task(asyncio.to_thread(cache.obtain, 'same', first_load, stop=owner_stop))
    await started.wait()
    second = asyncio.create_task(asyncio.to_thread(cache.obtain, 'same', second_load, stop=other_stop))
    await waiting.wait()
    if cancel_owner:
        owner_stop.retire()
    release.set()
    results = await asyncio.wait_for(asyncio.gather(first, second, return_exceptions=True), 5)
    if cancel_owner:
        assert isinstance(results[0], ReadInterrupted)
        assert results[1] == 42 and loads == [True]
    else:
        assert all(isinstance(item, TimeoutError) and str(item) == 'provider timeout' for item in results)
        assert not loads


async def test_daily_contract_stops_before_next_file_and_does_not_cache_cancelled_work(tmp_path, monkeypatch):
    work = ReadWork()
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    calls = []
    manifest = {'observations': {'005930': 'first', '000660': 'second'}, 'corrections': {}}

    def read(_data_dir, identity):
        calls.append(identity)
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(5)
        return {'unadjusted': [], 'adjusted': [], 'adjusted_as_of': '2026-11-02'}

    monkeypatch.setattr(runner.store, 'read_object', read)

    async def query(operation):
        return await run_read_sync(operation, runner._daily_contract, tmp_path, manifest,
                                   ['005930', '000660'], stop=operation)

    flight = work.start(query)
    await entered.wait()
    work.begin_read_shutdown()
    release.set()
    with pytest.raises(ReadInterrupted):
        await flight.result()
    assert (await work.wait_read_work()).failures == ()
    assert calls == ['first']
    assert not any(key[0] == str(tmp_path.resolve()) for key in snapshots.shared.entries)
