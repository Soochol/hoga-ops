from __future__ import annotations

import asyncio

import pytest

from hoga.live.kis_account_pool import (
    KisAccountLease,
    KisAccountReservationDeferred,
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

    async def lease(self, *, cooldown_key, reserve_one=False):
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
        scheduler.submit(key="shared", endpoint="daily", priority="background", call=shared_background)
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
async def test_capacity_scheduler_marks_account_cooldown_on_rate_limit() -> None:
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

    assert pool.cooldowns == [(0, ("past-minute", "KRX"), 10.0)]
    assert pool.released == [0]
    await scheduler.aclose()


@pytest.mark.asyncio
async def test_capacity_scheduler_translates_no_account_to_capacity_cooldown() -> None:
    class _NoAccountPool(_FakePool):
        async def lease(self, *, cooldown_key, reserve_one=False):
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
async def test_capacity_scheduler_snapshot_reports_background_deferrals() -> None:
    class _ReservedPool(_FakePool):
        async def lease(self, *, cooldown_key, reserve_one=False):
            if reserve_one:
                raise KisAccountReservationDeferred("reserved user-visible KIS account capacity")
            return await super().lease(cooldown_key=cooldown_key, reserve_one=reserve_one)

    scheduler = KisCapacityScheduler(
        name="test",
        account_pool=_ReservedPool(),
        max_workers=1,
        max_pending_requests=1000,
        account_cooldown_s=10.0,
    )

    task = asyncio.create_task(
        scheduler.submit(
            key="background",
            endpoint="quotes",
            priority="background",
            cooldown_scope="quotes",
            call=lambda kis: asyncio.sleep(0),
        )
    )
    await asyncio.sleep(0.02)

    snap = scheduler.snapshot()
    assert snap["background_deferred_due_to_reserved_capacity"] >= 1
    assert snap["background_deferred_due_to_user_visible"] == 0
    assert not task.done()

    await scheduler.aclose()
    task.cancel()

