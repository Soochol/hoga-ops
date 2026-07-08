from __future__ import annotations

import asyncio

import pytest

from hoga.live.kis_account_pool import (
    KisAccountLease,
    KisNoAccountAvailable,
)
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
    KisCapacityScheduler,
)
from hoga.live.kis_client import KisRateLimitError


class _FakeKis:
    def __init__(self, account_id: int) -> None:
        self.account_id = account_id


class _FakePool:
    def __init__(self) -> None:
        self.clients = [_FakeKis(0), _FakeKis(1)]
        self.next = 0
        self.released: list[int] = []
        self.cooldowns: list[tuple[int, object, float]] = []

    def configured_accounts(self):
        return [client.account_id for client in self.clients]

    async def lease(self, *, cooldown_key):
        client = self.clients[self.next % len(self.clients)]
        self.next += 1
        return KisAccountLease(account_id=client.account_id, client=client)

    def release(self, account_id: int) -> None:
        self.released.append(account_id)

    def mark_cooldown(self, account_id: int, cooldown_key, seconds: float) -> None:
        self.cooldowns.append((account_id, cooldown_key, seconds))

    def snapshot(self):
        return []


@pytest.mark.asyncio
async def test_capacity_scheduler_injects_leased_client_and_releases_account() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    result = await scheduler.submit(
        key=("k", 1),
        endpoint="past-minute",
        priority="user_visible",
        cooldown_scope="KRX",
        call=lambda kis: asyncio.sleep(0, result=kis.account_id),
    )

    assert result == 0
    assert pool.released == [0]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_coalesces_same_key() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    calls = 0

    async def call(kis):
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.01)
        return kis.account_id

    r1, r2 = await asyncio.gather(
        scheduler.submit(
            key="same",
            endpoint="past-minute",
            priority="user_visible",
            cooldown_scope="KRX",
            call=call,
        ),
        scheduler.submit(
            key="same",
            endpoint="past-minute",
            priority="user_visible",
            cooldown_scope="KRX",
            call=call,
        ),
    )

    assert (r1, r2) == (0, 0)
    assert calls == 1
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_rejects_new_unique_request_when_pending_full() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1,
        account_cooldown_s=10.0,
    )
    release_first = asyncio.Event()

    async def first(kis):
        await release_first.wait()
        return "first"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)

    with pytest.raises(KisCapacityOverloaded):
        await scheduler.submit(
            key="second",
            endpoint="test",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="second"),
        )
    assert scheduler.snapshot()["overloaded_rejections"] == 1

    release_first.set()
    assert await first_task == "first"
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_promotes_queued_background_when_user_visible_coalesces() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    release_first = asyncio.Event()
    order: list[str] = []

    async def first(kis):
        order.append("first")
        await release_first.wait()
        return "first"

    async def shared_background(kis):
        order.append("shared")
        return "shared"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)
    background_task = asyncio.create_task(
        scheduler.submit(
            key="shared",
            endpoint="daily",
            priority="background",
            call=shared_background,
        )
    )
    await asyncio.sleep(0)
    user_task = asyncio.create_task(
        scheduler.submit(
            key="shared",
            endpoint="daily",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="ignored"),
        )
    )

    release_first.set()
    assert await first_task == "first"
    assert await user_task == "shared"
    assert await background_task == "shared"
    assert order == ["first", "shared"]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_fails_over_to_next_account_on_rate_limit() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    attempts: list[int] = []

    async def limited_once(kis):
        attempts.append(kis.account_id)
        if kis.account_id == 0:
            raise KisRateLimitError("EGW00201 rate limited")
        return kis.account_id

    result = await scheduler.submit(
        key="failover",
        endpoint="past-minute",
        priority="user_visible",
        cooldown_scope="KRX",
        call=limited_once,
    )

    assert result == 1
    assert attempts == [0, 1]
    assert pool.cooldowns == [(0, ("past-minute", "KRX"), 10.0)]
    assert pool.released == [0, 1]
    assert scheduler.snapshot()["rate_limit_failovers"] == 1
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_marks_every_account_cooldown_when_all_rate_limited() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    async def limited(kis):
        raise KisRateLimitError("EGW00201 rate limited")

    with pytest.raises(KisRateLimitError):
        await scheduler.submit(
            key="limited",
            endpoint="past-minute",
            priority="user_visible",
            cooldown_scope="KRX",
            call=limited,
        )

    assert pool.cooldowns == [
        (0, ("past-minute", "KRX"), 10.0),
        (1, ("past-minute", "KRX"), 10.0),
    ]
    assert pool.released == [0, 1]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_failover_pool_exhaustion_raises_rate_limit() -> None:
    class _ExhaustAfterFirstPool(_FakePool):
        async def lease(self, *, cooldown_key):
            if self.next > 0:
                raise KisNoAccountAvailable("all cooling")
            return await super().lease(cooldown_key=cooldown_key)

    pool = _ExhaustAfterFirstPool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    async def limited(kis):
        raise KisRateLimitError("EGW00201 rate limited")

    with pytest.raises(KisRateLimitError):
        await scheduler.submit(
            key="limited",
            endpoint="past-minute",
            priority="user_visible",
            cooldown_scope="KRX",
            call=limited,
        )

    assert pool.cooldowns == [(0, ("past-minute", "KRX"), 10.0)]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_translates_no_account_to_capacity_cooldown() -> None:
    class _NoAccountPool(_FakePool):
        async def lease(self, *, cooldown_key):
            raise KisNoAccountAvailable("all cooling")

    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=_NoAccountPool(),
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    with pytest.raises(KisCapacityCooldown):
        await scheduler.submit(
            key="blocked",
            endpoint="past-minute",
            priority="user_visible",
            cooldown_scope="KRX",
            call=lambda kis: asyncio.sleep(0),
        )

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_does_not_start_background_while_user_visible_is_queued() -> None:
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    release_first = asyncio.Event()
    order: list[str] = []

    async def first(kis):
        order.append("first")
        await release_first.wait()
        return "first"

    async def background(kis):
        order.append("background")
        return "background"

    async def user_visible(kis):
        order.append("user_visible")
        return "user_visible"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=first)
    )
    await asyncio.sleep(0)
    background_task = asyncio.create_task(
        scheduler.submit(key="background", endpoint="test", priority="background", call=background)
    )
    user_task = asyncio.create_task(
        scheduler.submit(key="user", endpoint="test", priority="user_visible", call=user_visible)
    )

    release_first.set()
    assert await first_task == "first"
    assert await user_task == "user_visible"
    assert await background_task == "background"
    assert order == ["first", "user_visible", "background"]

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_promotion_residue_does_not_wedge_resubmit() -> None:
    """A promoted request leaves its original (rank-10) queue entry behind. That
    stale entry must not destroy the state of a LATER same-key request that
    reuses the key after the promotion settled — otherwise the resubmit's future
    is never resolved and its caller hangs forever (residue-cleanup bug)."""
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    started1 = asyncio.Event()
    release1 = asyncio.Event()
    started2 = asyncio.Event()
    release2 = asyncio.Event()

    async def blocker1(kis):
        started1.set()
        await release1.wait()
        return "b1"

    async def shared_call(kis):
        return "shared"

    async def blocker2(kis):
        started2.set()
        await release2.wait()
        return "b2"

    async def resubmit_call(kis):
        return "resubmit"

    # 1. Occupy the single worker with blocker1 (user_visible).
    b1_task = asyncio.create_task(
        scheduler.submit(key="b1", endpoint="test", priority="user_visible", call=blocker1)
    )
    await started1.wait()

    # 2. Background "shared" queues behind blocker1 (rank-10 entry E1).
    bg_task = asyncio.create_task(
        scheduler.submit(key="shared", endpoint="daily", priority="background", call=shared_call)
    )
    await asyncio.sleep(0)

    # 3. user_visible "shared" promotes it → rank-0 entry E2; E1 stays behind.
    uv_task = asyncio.create_task(
        scheduler.submit(
            key="shared",
            endpoint="daily",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="ignored"),
        )
    )
    await asyncio.sleep(0)

    # 4. blocker2 (user_visible) queues behind → the worker will land on it right
    #    after running the promoted "shared", giving us a hold point.
    b2_task = asyncio.create_task(
        scheduler.submit(key="b2", endpoint="test", priority="user_visible", call=blocker2)
    )
    await asyncio.sleep(0)

    # 5. Release blocker1 → worker runs promoted "shared" (E2), cleans it up, then
    #    blocks on blocker2. The rank-10 residue E1 is still queued.
    release1.set()
    assert await bg_task == "shared"
    assert await uv_task == "shared"
    await started2.wait()

    # 6. Same key "shared" is fresh (inflight cleared) — new background submit.
    resubmit_task = asyncio.create_task(
        scheduler.submit(key="shared", endpoint="daily", priority="background", call=resubmit_call)
    )
    await asyncio.sleep(0)

    # 7. Release blocker2 → worker drains residue E1 (future already done) then the
    #    resubmit entry. Pre-fix, E1's cleanup wipes the resubmit's state and the
    #    resubmit is skipped → hang. Post-fix, E1 skips cleanup (not the current
    #    inflight future) and the resubmit runs.
    release2.set()
    result = await asyncio.wait_for(resubmit_task, timeout=1.0)
    assert result == "resubmit"
    assert await b1_task == "b1"
    assert await b2_task == "b2"

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_call_cancelled_error_does_not_wedge_caller() -> None:
    """A CancelledError escaping the call must resolve the caller's future (as
    cancelled) instead of leaving it pending forever, and the scheduler must
    accept new work afterwards (worker revives)."""
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    async def cancel_call(kis):
        raise asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(
            scheduler.submit(
                key="c",
                endpoint="test",
                priority="user_visible",
                call=cancel_call,
            ),
            timeout=1.0,
        )

    # The dead worker must be revived by the next submit (_ensure_started).
    result = await asyncio.wait_for(
        scheduler.submit(
            key="ok",
            endpoint="test",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="ok"),
        ),
        timeout=1.0,
    )
    assert result == "ok"

    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_aclose_resolves_queued_futures() -> None:
    """aclose must resolve (cancel) requests still waiting in the queue so their
    callers don't hang through shutdown."""
    pool = _FakePool()
    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=pool,
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )
    started = asyncio.Event()
    release = asyncio.Event()

    async def blocker(kis):
        started.set()
        await release.wait()
        return "blocker"

    first_task = asyncio.create_task(
        scheduler.submit(key="first", endpoint="test", priority="user_visible", call=blocker)
    )
    await started.wait()

    # Second request is stuck in the queue behind the busy worker.
    second_task = asyncio.create_task(
        scheduler.submit(
            key="second",
            endpoint="test",
            priority="user_visible",
            call=lambda kis: asyncio.sleep(0, result="second"),
        )
    )
    await asyncio.sleep(0)

    await scheduler.aclose()

    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(second_task, timeout=1.0)
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(first_task, timeout=1.0)
