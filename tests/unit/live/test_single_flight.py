from __future__ import annotations

import asyncio

import pytest

from hoga.live.single_flight import SingleFlight


@pytest.mark.asyncio
async def test_same_key_serialises_concurrent_callers() -> None:
    sf = SingleFlight()
    active = 0
    peak = 0

    async def worker() -> None:
        nonlocal active, peak
        async with sf.acquire("code"):
            active += 1
            peak = max(peak, active)
            # Yield so a second holder would be observed if the gate leaked.
            await asyncio.sleep(0)
            active -= 1

    await asyncio.gather(worker(), worker(), worker())

    assert peak == 1


@pytest.mark.asyncio
async def test_distinct_keys_run_concurrently() -> None:
    sf = SingleFlight()
    active = 0
    peak = 0

    async def worker(key: str) -> None:
        nonlocal active, peak
        async with sf.acquire(key):
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1

    await asyncio.gather(worker("a"), worker("b"))

    assert peak == 2


@pytest.mark.asyncio
async def test_lock_is_reused_per_key() -> None:
    sf = SingleFlight()
    async with sf.acquire("code"):
        pass
    async with sf.acquire("code"):
        pass
    # Same key must map to one lock object, not a fresh one per acquire.
    assert list(sf._locks) == ["code"]
