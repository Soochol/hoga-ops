"""Concurrent REST requests: ownership, pacing isolation, and transient auth."""
import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest

from hoga.live import kiwoom_capacity
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, KiwoomCapacityScheduler
from hoga.live.kiwoom_errors import KiwoomAuthTransientError
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_token_provider import KiwoomAuthTransient


async def settle():
    for _ in range(30):
        await asyncio.sleep(0)


async def stop(scheduler, tasks):
    await scheduler.aclose()
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_running_request_promotion_does_not_execute_twice():
    scheduler = KiwoomCapacityScheduler(workers=2, rate_per_sec=1e9)
    release, entered = asyncio.Event(), asyncio.Event()
    calls = []

    async def fetch(_):
        calls.append("call")
        entered.set()
        await release.wait()
        return "result"

    tasks = [asyncio.create_task(scheduler.submit(
        key="shared", api_id="ka10080", priority="background", call=fetch,
    ))]
    try:
        await entered.wait()
        tasks.append(asyncio.create_task(scheduler.submit(
            key="shared", api_id="ka10080", priority="user_visible", call=fetch,
        )))
        await settle()
        assert len(calls) == 1
        release.set()
        assert await asyncio.gather(*tasks) == ["result", "result"]
    finally:
        await stop(scheduler, tasks)


async def test_queued_promotion_skips_old_record_with_multiple_workers():
    scheduler = KiwoomCapacityScheduler(workers=2, rate_per_sec=1e9)
    blockers, release = asyncio.Event(), asyncio.Event()
    calls = []

    async def block(_):
        await blockers.wait()

    async def fetch(_):
        calls.append("call")
        await release.wait()
        return "result"

    tasks = [asyncio.create_task(scheduler.submit(
        key=f"block{i}", api_id="ka10001", priority="background", call=block,
    )) for i in range(2)]
    try:
        await settle()
        for priority in ("background", "user_visible"):
            tasks.append(asyncio.create_task(scheduler.submit(
                key="same", api_id="ka10080", priority=priority, call=fetch,
            )))
            await settle()
        blockers.set()
        await settle()
        assert calls == ["call"]
        release.set()
        await asyncio.gather(*tasks)
    finally:
        await stop(scheduler, tasks)


async def test_pacing_waits_do_not_block_an_unrelated_ready_tr():
    scheduler = KiwoomCapacityScheduler(workers=4)
    scheduler._bucket(0, "ka10081")._next_at = time.monotonic() + 3600
    called = asyncio.Event()

    async def background(_):
        pytest.fail("blocked TR was sent before its available time")

    async def quote(_):
        called.set()
        return "quote"

    tasks = [asyncio.create_task(scheduler.submit(
        key=f"background{i}", api_id="ka10081", priority="background", call=background,
    )) for i in range(4)]
    try:
        await settle()
        tasks.append(asyncio.create_task(scheduler.submit(
            key="quote", api_id="ka10095", priority="user_visible", call=quote,
        )))
        await settle()
        assert called.is_set(), "pacing sleepers must not occupy all HTTP workers"
    finally:
        await stop(scheduler, tasks)


@pytest.mark.parametrize("reason", ["HTTP 503", "token reissue cooldown"])
async def test_transient_token_failure_does_not_invalidate_or_flag_app_key(reason):
    class Provider:
        invalidations = 0

        def get_token(self):
            raise KiwoomAuthTransient(reason)

        def invalidate(self):
            self.invalidations += 1

    def unexpected_request(_):
        pytest.fail("token issue failed, no data request should be sent")

    provider = Provider()
    client = KiwoomRestClient(provider, transport=httpx.MockTransport(unexpected_request))
    scheduler = KiwoomCapacityScheduler(workers=1, rate_per_sec=1e9)
    scheduler.set_clients([client])
    try:
        with pytest.raises(KiwoomAuthTransientError) as error:
            await scheduler.submit(
                key="transient", api_id="ka10001", priority="user_visible",
                call=lambda c: c.call("ka10001", {"stk_cd": "005930"}),
            )
        assert provider.invalidations == 0
        assert scheduler.snapshot()["auth_failing_accounts"] == []
        policy = classify_live_error(error.value)
        assert policy.permanent is False
        assert policy.kind == "transport"
    finally:
        await scheduler.aclose()
        await client.aclose()


async def test_promoted_records_do_not_consume_unique_queue_capacity():
    scheduler = KiwoomCapacityScheduler(workers=1, max_queued=2, rate_per_sec=1e9)
    release, entered = asyncio.Event(), asyncio.Event()

    async def block(_):
        entered.set()
        await release.wait()

    tasks = [asyncio.create_task(scheduler.submit(
        key="block", api_id="ka10001", priority="background", call=block,
    ))]
    try:
        await entered.wait()
        for key, priority in (("same", "background"), ("same", "user_visible"), ("other", "background")):
            tasks.append(asyncio.create_task(scheduler.submit(
                key=key, api_id="ka10001", priority=priority, call=block,
            )))
            await settle()
        assert not any(t.done() for t in tasks)
        assert scheduler.snapshot()["queued"] == 2
        with pytest.raises(KiwoomCapacityOverloaded):
            await scheduler.submit(key="overflow", api_id="ka10001", priority="background", call=block)
        release.set()
        await asyncio.gather(*tasks)
    finally:
        await stop(scheduler, tasks)


async def test_close_settles_running_and_queued_waiters():
    scheduler = KiwoomCapacityScheduler(workers=1)
    entered, release = asyncio.Event(), asyncio.Event()

    async def block(_):
        entered.set()
        await release.wait()

    tasks = [asyncio.create_task(scheduler.submit(
        key="running", api_id="ka10001", priority="background", call=block,
    ))]
    await entered.wait()
    tasks.append(asyncio.create_task(scheduler.submit(
        key="queued", api_id="ka10001", priority="background", call=block,
    )))
    await settle()
    try:
        await scheduler.aclose()
        await settle()
        assert all(task.cancelled() for task in tasks)
        assert scheduler.snapshot()["inflight"] == 0
        release.set()
        await scheduler.submit(key="reopened", api_id="ka10001", priority="background", call=block)
    finally:
        await stop(scheduler, tasks)


@pytest.mark.parametrize("second_fails", [False, True])
async def test_transient_auth_failover_is_bounded_and_preserves_tokens(second_fails):
    class Client:
        def __init__(self, account):
            self.account = account
            self.invalidations = 0

        async def invalidate_token(self):
            self.invalidations += 1

    clients = [Client(i) for i in range(3)]
    scheduler = KiwoomCapacityScheduler(workers=1, rate_per_sec=1e9)
    scheduler.set_clients(clients)
    calls = []

    async def fetch(client):
        calls.append(client.account)
        if client.account == 0 or second_fails:
            raise KiwoomAuthTransientError("temporary token failure")
        return "ok"

    try:
        if second_fails:
            with pytest.raises(KiwoomAuthTransientError):
                await scheduler.submit(key="same", api_id="ka10001", priority="user_visible", call=fetch)
        else:
            assert await scheduler.submit(
                key="same", api_id="ka10001", priority="user_visible", call=fetch,
            ) == "ok"
        assert calls == [0, 1]
        assert [c.invalidations for c in clients] == [0, 0, 0]
        assert scheduler.snapshot()["auth_failures_by_account"] == {}
        assert scheduler.snapshot()["auth_failing_accounts"] == []
    finally:
        await scheduler.aclose()


async def test_ready_selection_preserves_per_account_spacing(monkeypatch):
    now = [100.0]
    monkeypatch.setattr(kiwoom_capacity, "time", SimpleNamespace(monotonic=lambda: now[0]))
    scheduler = KiwoomCapacityScheduler(workers=4)
    scheduler.set_clients([0, 1])
    sent = []

    async def fetch(client):
        sent.append((client, now[0]))

    tasks = [asyncio.create_task(scheduler.submit(
        key=i, api_id="ka10080", priority="background", call=fetch,
    )) for i in range(4)]
    try:
        await settle()
        assert sent == [(0, 100.0), (1, 100.0)]
        now[0] = 100.25
        scheduler._wake.set()
        await settle()
        assert sent == [(0, 100.0), (1, 100.0), (0, 100.25), (1, 100.25)]
        await asyncio.gather(*tasks)
    finally:
        await stop(scheduler, tasks)
