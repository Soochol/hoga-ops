"""A ready market read must reserve admission before yielding a cached token."""
import asyncio
from datetime import datetime, timedelta
from types import SimpleNamespace

import httpx

from hoga.live import kiwoom_rest
from hoga.live.kiwoom_budget import budget_for
from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_token_provider import KIWOOM_KST, KiwoomCredentials, KiwoomTokenProvider


def cached_provider(tmp_path):
    def unexpected(_):
        raise AssertionError("synthetic memory cache must not issue a token")

    provider = KiwoomTokenProvider(
        KiwoomCredentials("synthetic-key", "synthetic-secret"), tmp_path / "token.json",
        _transport=httpx.MockTransport(unexpected),
    )
    provider._token = "synthetic-token"
    provider._token_expires_at = datetime.now(KIWOOM_KST) + timedelta(days=1)
    return provider


async def test_cached_token_reserves_read_gate_before_another_worker_is_dispatched(tmp_path, monkeypatch):
    provider = cached_provider(tmp_path)
    to_thread = asyncio.to_thread

    async def queued_thread(fn):
        # A deterministic executor scheduling gap, without wall-clock sleeps.
        for _ in range(3):
            await asyncio.sleep(0)
        return await to_thread(fn)

    monkeypatch.setattr(kiwoom_rest, "asyncio", SimpleNamespace(to_thread=queued_thread))
    entered, release = asyncio.Event(), asyncio.Event()
    sent = []

    async def respond(request):
        sent.append(request.headers["api-id"])
        entered.set()
        await release.wait()
        return httpx.Response(200, json={"return_code": 0})

    client = KiwoomRestClient(provider, transport=httpx.MockTransport(respond))
    budget_for(provider).interval = 3600
    scheduler = KiwoomCapacityScheduler(workers=2, rate_per_sec=1e9)
    scheduler.set_clients([client])
    tasks = [asyncio.create_task(scheduler.submit(
        key=api_id, api_id=api_id, priority="user_visible",
        call=lambda c, api_id=api_id: c.call(api_id, {"stk_cd": "005930"}),
    )) for api_id in ["ka10001", "ka10003"]]
    try:
        await asyncio.wait_for(entered.wait(), 1)
        for _ in range(20):
            await asyncio.sleep(0)
        # A second dispatched worker would be sleeping in budget.acquire(),
        # invisible to queue priority/failover even though no HTTP was sent.
        assert scheduler.snapshot()["queued"] == 1
        assert len(scheduler._started_accounts) == 1
        assert sent == ["ka10001"]
    finally:
        await scheduler.aclose()
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await client.aclose()
        provider.close()


def test_peek_obeys_refresh_boundary_and_invalidation(tmp_path):
    provider = cached_provider(tmp_path)
    try:
        assert provider.peek_token() == "synthetic-token"
        provider._token_expires_at = datetime.now(KIWOOM_KST) + timedelta(minutes=9)
        assert provider.peek_token() is None
        provider._token_expires_at = datetime.now(KIWOOM_KST) + timedelta(days=1)
        provider.invalidate()
        assert provider.peek_token() is None
    finally:
        provider.close()


def test_peek_does_not_wait_for_provider_lock_or_read_disk(tmp_path):
    provider = cached_provider(tmp_path)
    try:
        with provider._lock:
            assert provider.peek_token() is None
        expiry = provider._token_expires_at
        provider._token = None
        provider._write_cache("synthetic-disk-token", expiry)
        assert provider.peek_token() is None
    finally:
        provider.close()


async def test_disk_cache_miss_path_stays_off_event_loop(tmp_path, monkeypatch):
    import threading

    provider = cached_provider(tmp_path)
    provider._write_cache("synthetic-disk-token", provider._token_expires_at)
    provider._token = None
    main_thread = threading.get_ident()
    get_token = provider.get_token
    threads = []

    def observed_get():
        threads.append(threading.get_ident())
        return get_token()

    monkeypatch.setattr(provider, "get_token", observed_get)
    client = KiwoomRestClient(provider, transport=httpx.MockTransport(lambda _: None))
    try:
        assert await client._token() == "synthetic-disk-token"
        assert threads and threads[0] != main_thread
        # The warmed token no longer goes through the shared executor.
        assert await client._token() == "synthetic-disk-token"
        assert len(threads) == 1
    finally:
        await client.aclose()
        provider.close()


async def test_busy_provider_lock_falls_back_without_blocking_loop(tmp_path):
    provider = cached_provider(tmp_path)
    client = KiwoomRestClient(provider, transport=httpx.MockTransport(lambda _: None))
    provider._lock.acquire()
    task = asyncio.create_task(client._token())
    try:
        for _ in range(20):
            await asyncio.sleep(0)
        assert not task.done()
        provider._lock.release()
        assert await asyncio.wait_for(task, 1) == "synthetic-token"
    finally:
        if provider._lock.locked():
            provider._lock.release()
        await asyncio.gather(task, return_exceptions=True)
        await client.aclose()
        provider.close()
