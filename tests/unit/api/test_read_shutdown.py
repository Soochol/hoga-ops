import asyncio
import threading

import pytest

from hoga.api.read_shutdown import ReadDrainReport, ReadInterrupted, ReadShutdown, ReadWork


async def test_retirement_releases_shared_readers_before_cancellation_cleanup():
    work = ReadWork()
    entered, cancelled, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    cancellations = []

    async def query(_operation):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancellations.append(True)
            cancelled.set()
            await release.wait()
            raise

    flight = work.start(query)
    first = asyncio.create_task(flight.result())
    second = asyncio.create_task(flight.result())
    await entered.wait()
    work.begin_read_shutdown()
    work.begin_read_shutdown()
    await cancelled.wait()
    for reader in (first, second):
        with pytest.raises(ReadInterrupted):
            await reader
    with pytest.raises(ReadInterrupted):
        work.start(query)
    assert cancellations == [True]
    assert not flight.task.done()
    release.set()
    assert (await work.wait_read_work()).failures == ()


async def test_actual_thread_completion_precedes_dependency_release():
    work = ReadWork()
    entered = asyncio.Event()
    release, exited = threading.Event(), threading.Event()
    loop = asyncio.get_running_loop()
    dependency_closed = []

    def blocking():
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(5)
        exited.set()

    async def query(operation):
        await operation.run_sync(blocking)

    async def close():
        report = await work.wait_read_work()
        dependency_closed.append(True)
        return report

    flight = work.start(query)
    await entered.wait()
    work.begin_read_shutdown()
    with pytest.raises(ReadInterrupted):
        await flight.result()
    close_task = asyncio.create_task(close())
    await asyncio.sleep(0)
    try:
        assert not close_task.done()
        assert not exited.is_set()
        assert not dependency_closed
    finally:
        release.set()
        await close_task
    assert exited.is_set() and dependency_closed == [True]


async def test_caller_cancellation_cannot_cancel_shared_completion():
    work = ReadWork()
    entered, release = asyncio.Event(), asyncio.Event()

    async def query(_operation):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            await release.wait()

    work.start(query)
    await entered.wait()
    reads = ReadShutdown()
    reads.register(work)
    first = asyncio.create_task(reads.wait_finished())
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    second = asyncio.create_task(reads.wait_finished())
    release.set()
    assert (await second).failures == ()
    assert await reads.wait_finished() is second.result()


@pytest.mark.parametrize('failed', [False, True])
async def test_completed_result_or_error_wins_retirement(failed):
    work = ReadWork()

    async def query(_operation):
        if failed:
            raise ValueError('provider failure')
        return 42

    flight = work.start(query)
    await asyncio.gather(flight.task, return_exceptions=True)
    work.begin_read_shutdown()
    if failed:
        with pytest.raises(ValueError, match='provider failure'):
            await flight.result()
    else:
        assert await flight.result() == 42
    await work.wait_read_work()


@pytest.mark.parametrize('failed', [False, True])
async def test_incomplete_flight_cannot_publish_a_late_result_after_retirement(failed):
    work = ReadWork()
    entered = asyncio.Event()

    async def query(_operation):
        entered.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            if failed:
                raise ValueError('late error') from None
            return 42

    flight = work.start(query)
    await entered.wait()
    work.begin_read_shutdown()
    await asyncio.gather(flight.task, return_exceptions=True)
    with pytest.raises(ReadInterrupted):
        await flight.result()
    report = await work.wait_read_work()
    assert [str(error) for error in report.failures] == (['late error'] if failed else [])


async def test_external_caller_cancellation_is_not_a_restart_response():
    work = ReadWork()
    entered = asyncio.Event()

    async def query(_operation):
        entered.set()
        await asyncio.Event().wait()

    flight = work.start(query)
    await entered.wait()
    reader = asyncio.create_task(flight.result())
    await asyncio.sleep(0)
    reader.cancel()
    work.begin_read_shutdown()
    with pytest.raises(asyncio.CancelledError):
        await reader
    await work.wait_read_work()


async def test_owner_failure_does_not_skip_other_completion():
    seen = []

    class Broken:
        def begin_read_shutdown(self):
            raise RuntimeError('begin failed')

        async def wait_read_work(self):
            raise ValueError('drain failed')

    class Healthy:
        def begin_read_shutdown(self):
            seen.append('begin')

        async def wait_read_work(self):
            seen.append('drained')
            return ReadDrainReport()

    reads = ReadShutdown()
    reads.register(Broken())
    reads.register(Healthy())
    reads.begin()
    report = await reads.wait_finished()
    assert seen == ['begin', 'drained']
    assert [str(error) for error in report.failures] == ['begin failed', 'drain failed']


async def test_cooperative_stop_does_not_publish_after_blocking_read():
    work = ReadWork()
    entered = asyncio.Event()
    release = threading.Event()
    loop = asyncio.get_running_loop()
    published = []

    async def query(operation):
        def read():
            loop.call_soon_threadsafe(entered.set)
            assert release.wait(5)
            operation.checkpoint()
            published.append(True)
        await operation.run_sync(read)

    flight = work.start(query)
    await entered.wait()
    work.begin_read_shutdown()
    release.set()
    with pytest.raises(ReadInterrupted):
        await flight.result()
    assert (await work.wait_read_work()).failures == ()
    assert not published


async def test_failed_worker_is_reported_after_other_worker_acknowledges():
    work = ReadWork()
    entered = [asyncio.Event(), asyncio.Event()]
    releases = [threading.Event(), threading.Event()]
    loop = asyncio.get_running_loop()

    async def query(operation, index):
        def blocking():
            loop.call_soon_threadsafe(entered[index].set)
            assert releases[index].wait(5)
            if index == 0:
                raise ValueError('disk failed')
        await operation.run_sync(blocking)

    work.start(lambda operation: query(operation, 0))
    work.start(lambda operation: query(operation, 1))
    await asyncio.gather(*(event.wait() for event in entered))
    drain = asyncio.create_task(work.wait_read_work())
    await asyncio.sleep(0)
    releases[0].set()
    try:
        await asyncio.sleep(0)
        assert not drain.done()
    finally:
        releases[1].set()
    report = await drain
    assert [str(error) for error in report.failures] == ['disk failed']


async def test_read_retirement_preserves_durable_order_dispatch(tmp_path):
    from hoga.trading.commands import dispatch_command
    from hoga.trading.service import CommandJournal

    work = ReadWork()
    entered, release = asyncio.Event(), asyncio.Event()
    journal = CommandJournal(tmp_path / 'commands.sqlite3')
    payload, accepted = {'code': '005930'}, {'order_id': 'accepted-1'}
    calls, tasks = [], {}

    async def gateway():
        calls.append(True)
        entered.set()
        await release.wait()
        journal.finish('command-1', 'accepted', accepted)
        return accepted

    async def query(_operation):
        await asyncio.Event().wait()

    read = work.start(query)
    order = asyncio.create_task(dispatch_command(journal, tasks, 'command-1', payload, gateway, dict))
    await entered.wait()
    work.begin_read_shutdown()
    with pytest.raises(ReadInterrupted):
        await read.result()
    await work.wait_read_work()
    assert not order.done()
    assert journal.lookup('command-1')[1] == 'sending'
    release.set()
    assert await order == accepted
    # A new service instance after reload observes the durable acceptance, without re-submission.
    restored = CommandJournal(journal.path)
    assert await dispatch_command(restored, {}, 'command-1', payload, gateway, dict) == accepted
    assert calls == [True]
