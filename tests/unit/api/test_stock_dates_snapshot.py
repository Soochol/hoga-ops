from __future__ import annotations

import asyncio
import threading

import httpx
import pytest
from fastapi import FastAPI

from hoga.api import compute_jobs
from hoga.api.compute_pools import ComputePools
from hoga.api.queries import QueryEngine
from hoga.api.routes import build_router
from hoga.api.stock_dates_snapshot import StockDatesSnapshot
from hoga.compute_executor import ComputeExecutor


async def test_tabs_share_one_scan_and_cancelled_waiter_does_not_cancel_it():
    cache = StockDatesSnapshot()
    started, release = asyncio.Event(), asyncio.Event()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        started.set()
        await release.wait()
        return b"[]"

    callers = [asyncio.create_task(cache.get(lambda: 1, load)) for _ in range(20)]
    await started.wait()
    callers[0].cancel()
    release.set()
    results = await asyncio.gather(*callers, return_exceptions=True)
    assert isinstance(results[0], asyncio.CancelledError)
    assert results[1:] == [b"[]"] * 19
    assert await cache.get(lambda: 1, load) == b"[]"
    assert calls == 1


async def test_invalidation_during_scan_is_followed_once_and_shared():
    cache = StockDatesSnapshot()
    started, release = asyncio.Event(), asyncio.Event()
    revision = 1
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        captured = revision
        if calls == 1:
            started.set()
            await release.wait()
        return str(captured).encode()

    callers = [asyncio.create_task(cache.get(lambda: revision, load)) for _ in range(20)]
    await started.wait()
    revision = 2
    release.set()
    assert await asyncio.gather(*callers) == [b"2"] * 20
    assert calls == 2
    revision = 3
    assert await cache.get(lambda: revision, load) == b"3"
    assert calls == 3


async def test_failure_is_not_cached():
    cache = StockDatesSnapshot()

    async def fail():
        raise ValueError("scan failed")

    with pytest.raises(ValueError, match="scan failed"):
        await cache.get(lambda: 1, fail)

    async def succeed():
        return b"[]"

    assert await cache.get(lambda: 1, succeed) == b"[]"


async def test_missing_watcher_does_not_reuse_completed_result():
    cache = StockDatesSnapshot()
    calls = 0

    async def load():
        nonlocal calls
        calls += 1
        return str(calls).encode()

    assert await cache.get(lambda: None, load) == b"1"
    assert await cache.get(lambda: None, load) == b"2"


async def test_shared_route_waiters_still_obey_request_admission(tmp_path, monkeypatch):
    pools = ComputePools(wide=ComputeExecutor("thread", max_pending_requests=2), narrow=ComputeExecutor("thread"))
    entered, release = asyncio.Event(), threading.Event()
    loop = asyncio.get_running_loop()
    calls = []

    def scan(*args):
        calls.append(1)
        loop.call_soon_threadsafe(entered.set)
        assert release.wait(5)
        return b"[]"

    monkeypatch.setattr(compute_jobs, "stock_dates_job", scan)
    engine = QueryEngine(tmp_path)
    app = FastAPI()
    app.include_router(build_router(engine, compute=pools))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as client:
        first = asyncio.create_task(client.get("/api/stock-dates"))
        second = None
        try:
            await asyncio.wait_for(entered.wait(), 5)
            second = asyncio.create_task(client.get("/api/stock-dates"))

            async def waiting():
                while pools.wide.pending_requests != 2:
                    await asyncio.sleep(0)

            await asyncio.wait_for(waiting(), 5)
            rejected = await client.get("/api/stock-dates")
            assert rejected.status_code == 503
            assert rejected.json()["detail"]["code"] == "compute_capacity_exceeded"
            assert calls == [1]
            release.set()
            assert (await first).json() == []
            assert (await second).json() == []
            assert pools.wide.pending_requests == 0
        finally:
            release.set()
            await asyncio.gather(*(task for task in [first, second] if task), return_exceptions=True)
            engine.close()
