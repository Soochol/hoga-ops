"""이탈 독자가 남의 검색을 취소하지 않고, 마지막 이탈은 대기를 제거한다."""
import asyncio

import pytest
from fastapi import HTTPException, Request

from hoga.api.request_coalescer import ReadRequestCoalescer


def _request():
    messages = asyncio.Queue()
    return Request({"type": "http"}, messages.get), messages


async def test_identical_searches_share_work_when_one_reader_disconnects():
    coalescer = ReadRequestCoalescer[int]()
    started, finish = asyncio.Event(), asyncio.Event()
    calls = 0

    async def compute():
        nonlocal calls
        calls += 1
        started.set()
        await finish.wait()
        return 42

    first, messages = _request()
    second, _ = _request()
    a = asyncio.create_task(coalescer.run("same", compute, first))
    b = asyncio.create_task(coalescer.run("same", compute, second))
    await started.wait()
    messages.put_nowait({"type": "http.disconnect"})
    with pytest.raises(HTTPException) as error:
        await a
    assert error.value.status_code == 499
    assert not b.done()
    finish.set()
    assert await b == 42
    assert calls == 1
    assert not coalescer._inflight


@pytest.mark.parametrize("disconnect", [True, False])
async def test_last_reader_leaving_cancels_pending_work(disconnect):
    coalescer = ReadRequestCoalescer[int]()
    started, cancelled = asyncio.Event(), asyncio.Event()
    request, messages = _request()

    async def pending():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    reader = asyncio.create_task(coalescer.run("key", pending, request))
    await started.wait()
    if disconnect:
        messages.put_nowait({"type": "http.disconnect"})
        with pytest.raises(HTTPException):
            await reader
    else:
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
    await asyncio.wait_for(cancelled.wait(), 1)
    assert not coalescer._inflight


async def test_failure_is_shared_but_next_request_retries():
    coalescer = ReadRequestCoalescer[int]()
    request, _ = _request()

    async def fail():
        raise ValueError("bad query")

    with pytest.raises(ValueError, match="bad query"):
        await coalescer.run("key", fail, request)
    assert not coalescer._inflight

    async def success():
        return 7

    assert await coalescer.run("key", success, request) == 7


async def test_last_reader_cancellation_consumes_late_failure_and_close_drains_work():
    coalescer = ReadRequestCoalescer[int]()
    started, cancelled, finish = asyncio.Event(), asyncio.Event(), asyncio.Event()
    loop = asyncio.get_running_loop()
    errors = []
    previous = loop.get_exception_handler()
    loop.set_exception_handler(lambda _, context: errors.append(context))

    async def late_failure():
        started.set()
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            await finish.wait()
            raise RuntimeError("late failure") from None

    try:
        request, _ = _request()
        reader = asyncio.create_task(coalescer.run("k", late_failure, request))
        await started.wait()
        reader.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reader
        await cancelled.wait()
        finish.set()
        tasks = list(coalescer._tasks)
        await asyncio.gather(*tasks, return_exceptions=True)
        await coalescer.aclose()
        assert not coalescer._tasks
        assert not errors
        with pytest.raises(HTTPException) as error:
            await coalescer.run("new", late_failure, request)
        assert error.value.status_code == 503
    finally:
        loop.set_exception_handler(previous)


async def test_router_lifespan_closes_owned_read_requests(tmp_path):
    from hoga.api.screener import _read_requests_lifespan

    coalescer = ReadRequestCoalescer[int]()
    started, stopped = asyncio.Event(), asyncio.Event()

    async def pending():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            stopped.set()

    async with _read_requests_lifespan(coalescer)(None):
        request, _ = _request()
        reader = asyncio.create_task(coalescer.run("key", pending, request))
        await started.wait()
    assert stopped.is_set()
    with pytest.raises(asyncio.CancelledError):
        await reader
    assert not coalescer._tasks
