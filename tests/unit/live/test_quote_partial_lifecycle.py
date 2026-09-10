import asyncio
from datetime import date

import pytest

from hoga.live.api import LiveQuotesResponse
from hoga.live.live_quote_fetcher import LiveQuoteFetcher
from hoga.live.quote_models import Quote

DAY = date(2026, 9, 10)
CODES = [f'{i:06d}' for i in range(101)]


async def test_partial_failure_keeps_successes_and_marks_only_failed_cached_code():
    fetcher = LiveQuoteFetcher()

    async def warm(codes):
        return [Quote(c, 100, 0) for c in codes]

    await fetcher.fetch_and_gate(None, CODES, 'open', DAY, fetch_chunk_fn=warm)

    async def partial(codes):
        if codes == ['000100']:
            raise RuntimeError('synthetic failure')
        return [Quote(c, 200, 0) for c in codes]

    rows = await fetcher.fetch_and_gate(None, CODES, 'open', DAY, fetch_chunk_fn=partial)
    assert len(rows) == 101
    assert all(q.price == 200 and not q.stale for q in rows[:100])
    assert rows[-1].price == 100 and rows[-1].stale
    assert rows[-1].stale_reason == 'fetch_failed'
    cold = LiveQuoteFetcher()
    rows = await cold.fetch_and_gate(None, CODES, 'open', DAY, fetch_chunk_fn=partial)
    assert len(rows) == 100
    wire = LiveQuotesResponse(phase='open', quotes=rows, missing_codes=['000100']).model_dump()
    assert wire['missing_codes'] == ['000100']


async def test_timeout_fill_is_owned_until_shutdown_and_children_are_cancelled():
    fetcher = LiveQuoteFetcher()
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def blocked(codes):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    waiter = asyncio.create_task(fetcher.fetch_with_timeout(
        None, CODES, 'open', DAY, fetch_chunk_fn=blocked, timeout=None,
    ))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    assert not cancelled.is_set()  # cancelling an HTTP waiter preserves the fill
    await fetcher.aclose()
    assert cancelled.is_set()
    with pytest.raises(RuntimeError, match='closed'):
        await fetcher.fetch_with_timeout(None, [], 'open', DAY)


async def test_detached_failure_is_retrieved_and_logged(monkeypatch, caplog):
    fetcher = LiveQuoteFetcher()
    release, entered = asyncio.Event(), asyncio.Event()

    async def broken(*args, **kwargs):
        entered.set()
        await release.wait()
        raise RuntimeError('detached failure')

    monkeypatch.setattr(fetcher, 'fetch_and_gate', broken)
    waiter = asyncio.create_task(fetcher.fetch_with_timeout(timeout=None))
    await entered.wait()
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    tasks = tuple(fetcher._tasks)
    release.set()
    await asyncio.gather(*tasks, return_exceptions=True)
    assert 'background quote fill failed' in caplog.text
    assert not fetcher._tasks
    await fetcher.aclose()
