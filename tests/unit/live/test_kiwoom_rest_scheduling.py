"""Concurrent REST requests: ownership, pacing isolation, and transient auth."""
import asyncio
import time
from types import SimpleNamespace

import httpx
import pytest

from hoga.live import kiwoom_capacity
from hoga.live.error_policy import classify_live_error
from hoga.live.kiwoom_budget import budget_for
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded, KiwoomCapacityScheduler
from hoga.live.kiwoom_errors import KiwoomAuthTransientError
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.kiwoom_token_provider import KiwoomAuthTransient


async def settle():
    for _ in range(30):
        await asyncio.sleep(0)


def market_clients(count):
    class Provider:
        def get_token(self):
            return "synthetic"

    return [KiwoomRestClient(Provider(), transport=httpx.MockTransport(
        lambda _: pytest.fail("synthetic scheduling test must not send HTTP"),
    )) for _ in range(count)]


async def test_unrelated_trs_spread_while_token_lookups_have_not_reserved_read_budget():
    clients = market_clients(6)
    scheduler = KiwoomCapacityScheduler()
    scheduler.set_clients(clients)
    release, full = asyncio.Event(), asyncio.Event()
    seen = []

    async def fetch(client):
        seen.append(clients.index(client))
        if len(seen) == 6:
            full.set()
        # This represents the await in token lookup, before budget.acquire.
        await release.wait()

    tasks = [asyncio.create_task(scheduler.submit(
        key=i, api_id=f"synthetic-tr-{i}", priority="user_visible", call=fetch,
    )) for i in range(6)]
    try:
        await asyncio.wait_for(full.wait(), 1)
        assert seen == list(range(6))
        release.set()
        await asyncio.gather(*tasks)
        assert scheduler._started_accounts == {}
    finally:
        await stop(scheduler, tasks)
        await asyncio.gather(*(c.aclose() for c in clients))


async def test_private_read_budget_is_visible_when_choosing_market_account():
    clients = market_clients(2)
    scheduler = KiwoomCapacityScheduler()
    scheduler.set_clients(clients)
    # A private read on account 0 holds its group gate, including unrelated TRs.
    budget_for(clients[0]._provider)._next["read"] = time.monotonic() + 3600
    try:
        result = await asyncio.wait_for(scheduler.submit(
            key="chart", api_id="ka10081", priority="user_visible",
            call=lambda c: asyncio.sleep(0, result=clients.index(c)),
        ), 1)
        assert result == 1
    finally:
        await scheduler.aclose()
        await asyncio.gather(*(c.aclose() for c in clients))


async def test_shared_budget_wait_stays_queued_instead_of_occupying_http_worker():
    clients = market_clients(1)
    scheduler = KiwoomCapacityScheduler(workers=1)
    scheduler.set_clients(clients)
    budget_for(clients[0]._provider)._next["ka10081"] = time.monotonic() + 3600

    async def blocked(_):
        pytest.fail("shared TR gate must still be respected")

    tasks = [asyncio.create_task(scheduler.submit(
        key="blocked", api_id="ka10081", priority="user_visible", call=blocked,
    ))]
    try:
        await settle()
        assert scheduler._started_accounts == {}
        assert scheduler.snapshot()["queued"] == 1
        assert await asyncio.wait_for(scheduler.submit(
            key="ready", api_id="ka10001", priority="background",
            call=lambda _: asyncio.sleep(0, result="ready"),
        ), 1) == "ready"
        assert not tasks[0].done()
    finally:
        await stop(scheduler, tasks)
        await clients[0].aclose()


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


@pytest.mark.parametrize("priority,workers", [("background", 4), ("user_visible", 12)])
async def test_ready_selection_preserves_per_account_spacing(monkeypatch, priority, workers):
    now = [100.0]
    monkeypatch.setattr(kiwoom_capacity, "time", SimpleNamespace(monotonic=lambda: now[0]))
    scheduler = KiwoomCapacityScheduler(workers=workers)
    scheduler.set_clients([0, 1])
    sent = []

    async def fetch(client):
        sent.append((client, now[0]))

    tasks = [asyncio.create_task(scheduler.submit(
        key=i, api_id="ka10080", priority=priority, call=fetch,
    )) for i in range(12)]
    try:
        await settle()
        assert sent == [(0, 100.0), (1, 100.0)]
        for step in range(1, 6):
            now[0] = 100 + step * .25
            scheduler._wake.set()
            await settle()
            assert sent == [(account, 100 + tick * .25)
                            for tick in range(step + 1) for account in range(2)]
        await asyncio.gather(*tasks)
    finally:
        await stop(scheduler, tasks)


@pytest.mark.parametrize("phase", ["token", "admission", "http"])
def test_slow_phase_reports_only_stage_not_sensitive_exception(monkeypatch, caplog, phase):
    from hoga.live import kiwoom_rest

    ticks = iter([10.0, 10.5])
    monkeypatch.setattr(kiwoom_rest, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    with pytest.raises(ValueError, match="private-token-and-body"), kiwoom_rest._observe_phase("ka10064", phase):
        raise ValueError("private-token-and-body")
    assert f"api_id=ka10064 phase={phase} duration_ms=500.0" in caplog.text
    assert "private-token-and-body" not in caplog.text


def test_fast_phase_does_not_log(monkeypatch, caplog):
    from hoga.live import kiwoom_rest

    ticks = iter([10.0, 10.1])
    monkeypatch.setattr(kiwoom_rest, "time", SimpleNamespace(monotonic=lambda: next(ticks)))
    with kiwoom_rest._observe_phase("ka10064", "http"):
        pass
    assert "slow_phase" not in caplog.text


async def test_slow_queue_reports_public_metadata_without_request_key(monkeypatch, caplog):
    scheduler = KiwoomCapacityScheduler(workers=1, rate_per_sec=1e9)
    original = scheduler._make

    def old_request(*args):
        req = original(*args)
        req.queued_at = time.monotonic() - 10
        return req

    monkeypatch.setattr(scheduler, "_make", old_request)
    try:
        assert await scheduler.submit(
            key="private-account-and-body", api_id="ka10064", priority="user_visible",
            call=lambda _: asyncio.sleep(0, result="ready"),
        ) == "ready"
        assert "slow_queue pid=" in caplog.text
        assert "api_id=ka10064 priority=user_visible account=0" in caplog.text
        assert "private-account-and-body" not in caplog.text
    finally:
        await scheduler.aclose()
