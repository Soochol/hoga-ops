import asyncio
import logging

import pytest

from hoga.util.shutdown import finish_shutdown, shutdown_phase


async def test_repeated_caller_cancellation_waits_for_owned_cleanup():
    entered, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def cleanup():
        entered.set()
        await release.wait()
        calls.append('complete')
        return 42

    owned = asyncio.create_task(cleanup())
    caller = asyncio.create_task(finish_shutdown(owned))
    await entered.wait()
    for _ in range(2):
        caller.cancel()
        await asyncio.sleep(0)
        assert not caller.done() and not owned.cancelling()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert owned.result() == 42 and calls == ['complete']


async def test_cleanup_failure_after_caller_cancel_is_observed_without_late_future_warning():
    entered, release = asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()
    errors = []
    loop.set_exception_handler(lambda _loop, context: errors.append(context))

    async def cleanup():
        entered.set()
        await release.wait()
        raise OSError('write failed')

    try:
        caller = asyncio.create_task(finish_shutdown(asyncio.create_task(cleanup())))
        await entered.wait()
        caller.cancel()
        await asyncio.sleep(0)
        release.set()
        with pytest.raises(OSError, match='write failed'):
            await caller
        await asyncio.sleep(0)
        assert not errors
    finally:
        loop.set_exception_handler(previous)


@pytest.mark.parametrize('outcome', ['completed', 'cancelled', 'failed'])
def test_phase_records_scope_and_original_outcome(caplog, outcome):
    caplog.set_level(logging.INFO, logger='hoga.util.shutdown')
    error = {'cancelled': asyncio.CancelledError, 'failed': ValueError}.get(outcome)

    def invoke():
        with shutdown_phase('socket_close', account_id=2, epoch='test-epoch'):
            if error:
                raise error('original')

    if error:
        with pytest.raises(error, match='original'):
            invoke()
    else:
        invoke()
    assert f'outcome={outcome}' in caplog.text
    assert 'phase=socket_close elapsed_ms=' in caplog.text
    assert 'account_id=2' in caplog.text and 'epoch=test-epoch' in caplog.text
