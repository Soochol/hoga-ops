from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest

import hoga.trading.toss as module
from hoga.trading.toss import TossClient, TradingError


@pytest.fixture
async def paced(monkeypatch):
    clock = SimpleNamespace(now=10.0, sleeps=[])

    async def sleep(seconds):
        clock.sleeps.append(seconds)
        clock.now += seconds

    monkeypatch.setattr(module, "time", SimpleNamespace(monotonic=lambda: clock.now, time=time.time))
    monkeypatch.setattr(module, "asyncio", SimpleNamespace(Lock=asyncio.Lock, sleep=sleep))
    client = TossClient("fake", "fake")
    monkeypatch.setattr(client, "_info_peak", lambda: False)
    yield client, clock
    await client.close()


async def test_groups_are_independent_and_history_is_shared(paced):
    client, clock = paced
    await client._pace("/api/v1/orders", "GET")
    await client._pace("/api/v1/orders/a/cancel", "POST")
    assert clock.sleeps == []
    await client._pace("/api/v1/orders/a", "GET")
    assert clock.sleeps == pytest.approx([0.21])


@pytest.mark.parametrize("peak,interval", [(False, 0.175), (True, 0.35)])
async def test_info_group_respects_kst_peak(paced, monkeypatch, peak, interval):
    client, clock = paced
    monkeypatch.setattr(client, "_info_peak", lambda: peak)
    await client._pace("/api/v1/buying-power", "GET")
    await client._pace("/api/v1/sellable-quantity", "GET")
    assert clock.sleeps == pytest.approx([interval])


@pytest.mark.parametrize("method", ["GET", "POST"])
async def test_lower_header_limit_applies_to_already_waiting_requests(paced, monkeypatch, method):
    client, clock = paced
    await client._pace("/api/v1/orders", method)
    original_sleep = module.asyncio.sleep

    async def lowering_sleep(seconds):
        if not clock.sleeps:
            client._observe_rate("/api/v1/orders", method, httpx.Response(200, headers={"X-RateLimit-Limit": "2"}))
        await original_sleep(seconds)

    monkeypatch.setattr(module.asyncio, "sleep", lowering_sleep)
    await client._pace("/api/v1/orders/a", method)
    assert sum(clock.sleeps) == pytest.approx(0.525)


async def test_remaining_zero_and_invalid_headers(paced):
    client, clock = paced
    client._observe_rate("/api/v1/orders", "GET", httpx.Response(200, headers={
        "X-RateLimit-Limit": "invalid", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "0.7",
    }))
    await client._pace("/api/v1/orders", "GET")
    assert clock.sleeps == pytest.approx([0.7])
    client._observe_rate("/api/v1/orders", "GET", httpx.Response(200, headers={
        "X-RateLimit-Limit": "0", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "nan",
    }))
    assert client._interval("history") == pytest.approx(0.21)


async def test_429_delays_next_write_without_replaying_this_write(paced):
    client, clock = paced
    posts = []

    async def handle(request):
        posts.append(request)
        return httpx.Response(429, headers={"Retry-After": "1.2", "X-RateLimit-Limit": "2"},
                              json={"error": {"code": "rate-limit-exceeded", "message": "slow down"}})

    await client.http.aclose()
    client.http = httpx.AsyncClient(base_url=client.BASE_URL, transport=httpx.MockTransport(handle))
    client._token = "fake-token"
    client._expires_at = 1000
    with pytest.raises(TradingError) as rejected:
        await client.request("POST", "/api/v1/orders/a/cancel", account=1, body={})
    assert rejected.value.code == "rate-limit-exceeded"
    assert len(posts) == 1
    await client._pace("/api/v1/orders/b/cancel", "POST")
    assert clock.sleeps == pytest.approx([1.2])


@pytest.mark.parametrize("limit", [10, 3])
async def test_concurrent_cancels_share_write_quota_with_create_and_modify(paced, limit):
    client, clock = paced
    client._token = "fake-token"
    client._expires_at = 1000
    client._observe_rate("/api/v1/orders/a/cancel", "POST", httpx.Response(
        200, headers={"X-RateLimit-Limit": str(limit)},
    ))
    entered, release = asyncio.Event(), asyncio.Event()
    sends = []

    async def handle(request):
        sends.append((request.url.path, clock.now))
        if len(sends) == 22:
            entered.set()
        await release.wait()
        return httpx.Response(200, json={"result": {"orderId": "accepted"}})

    await client.http.aclose()
    client.http = httpx.AsyncClient(base_url=client.BASE_URL, transport=httpx.MockTransport(handle))
    paths = [f"/api/v1/orders/{i}/cancel" for i in range(20)] + ["/api/v1/orders", "/api/v1/orders/other/modify"]
    tasks = [asyncio.create_task(client.request("POST", path, account=1, body={})) for path in paths]
    try:
        await asyncio.wait_for(entered.wait(), 3)
        # All requests have been paced and sent while no response has returned.
        assert all(not task.done() for task in tasks)
        assert [b[1] - a[1] for a, b in zip(sends, sends[1:], strict=False)] == pytest.approx([1.05 / limit] * 21)
        assert len({path for path, _ in sends}) == 22
    finally:
        release.set()
        await asyncio.gather(*tasks)
