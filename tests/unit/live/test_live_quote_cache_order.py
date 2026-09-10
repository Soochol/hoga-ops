"""Overlapping quote requests must not roll a successful cache back."""
import asyncio
from datetime import date, timedelta

import pytest

from hoga.live.live_quote_fetcher import LiveQuoteFetcher
from hoga.live.quote_models import Quote

DAY = date(2026, 9, 10)


@pytest.mark.parametrize("new_phase,new_day", [
    ("open", DAY), ("closed", DAY), ("open", DAY + timedelta(days=1)),
])
async def test_late_older_request_cannot_replace_newer_success(new_phase, new_day):
    fetcher = LiveQuoteFetcher()
    entered, release = asyncio.Event(), asyncio.Event()

    async def older(codes):
        entered.set()
        await release.wait()
        return [Quote(code, 100, 0) for code in codes]

    async def newer(codes):
        return [Quote(code, 200, 0) for code in codes]

    first = asyncio.create_task(fetcher.fetch_and_gate(
        None, ["005930"], "open", DAY, fetch_chunk_fn=older,
    ))
    try:
        await entered.wait()
        await fetcher.fetch_and_gate(
            None, ["005930", "000660"], new_phase, new_day, fetch_chunk_fn=newer,
        )
        release.set()
        older_rows = await first
        cached = fetcher.stale_last_good(["005930"], new_phase, new_day)
        assert cached[0].price == 200
        if new_day == DAY:
            assert older_rows[0].price == 200
        if new_phase == "closed":
            async def unexpected(_):
                pytest.fail("late open result must not invalidate the closing sample")
            assert (await fetcher.fetch_and_gate(
                None, ["005930"], "closed", new_day, fetch_chunk_fn=unexpected,
            ))[0].price == 200
    finally:
        release.set()
        await first


async def test_newer_failed_request_does_not_discard_older_success():
    fetcher = LiveQuoteFetcher()
    entered, release = asyncio.Event(), asyncio.Event()

    async def success(codes):
        entered.set()
        await release.wait()
        return [Quote(code, 100, 0) for code in codes]

    async def fail(_):
        raise RuntimeError("synthetic request failure")

    first = asyncio.create_task(fetcher.fetch_and_gate(
        None, ["005930"], "open", DAY, fetch_chunk_fn=success,
    ))
    await entered.wait()
    try:
        assert await fetcher.fetch_and_gate(
            None, ["005930"], "open", DAY, fetch_chunk_fn=fail,
        ) == []
        release.set()
        await first
        assert fetcher.stale_last_good(["005930"], "open", DAY)[0].price == 100
    finally:
        release.set()
        await first


async def test_closed_fetch_requests_only_missing_codes_and_keeps_output_order():
    fetcher = LiveQuoteFetcher()
    warm_codes = [f"{i:06d}" for i in range(100)]

    async def initial(codes):
        return [Quote(code, 100, 0) for code in codes]

    await fetcher.fetch_and_gate(None, warm_codes, "closed", DAY, fetch_chunk_fn=initial)
    calls = []

    async def fill(codes):
        calls.append(codes)
        return [Quote(code, 200, 0) for code in codes]

    requested = [warm_codes[0], "999999", *warm_codes[1:]]
    rows = await fetcher.fetch_and_gate(None, requested, "closed", DAY, fetch_chunk_fn=fill)
    assert calls == [["999999"]]
    assert [row.code for row in rows] == requested
    assert [row.price for row in rows[:2]] == [100, 200]


async def test_generation_is_per_code_and_venue_not_whole_request():
    fetcher = LiveQuoteFetcher()
    entered, release = asyncio.Event(), asyncio.Event()

    async def older(codes):
        entered.set()
        await release.wait()
        return [Quote(code, 100, 0) for code in codes]

    async def newer(codes):
        return [Quote(code, 200, 0) for code in codes]

    first = asyncio.create_task(fetcher.fetch_and_gate(
        None, ["005930", "000660"], "open", DAY, fetch_chunk_fn=older,
    ))
    try:
        await entered.wait()
        await fetcher.fetch_and_gate(None, ["005930"], "open", DAY, fetch_chunk_fn=newer)
        await fetcher.fetch_and_gate(
            None, ["000660"], "open", DAY, venue="NXT", fetch_chunk_fn=newer,
        )
        release.set()
        rows = await first
        assert [row.price for row in rows] == [200, 100]
        assert fetcher.stale_last_good(["000660"], "open", DAY, venue="NXT")[0].price == 200
    finally:
        release.set()
        await first
