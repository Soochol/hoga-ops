import asyncio
import datetime as dt
from dataclasses import replace

import pytest

from hoga.live.minute_day_cache import MinuteBar, MinuteDayCache, MinuteSnapshot, close_ms
from hoga.util.timeenc import KST

DAY = dt.date(2026, 10, 30)
OPEN = int(dt.datetime.combine(DAY, dt.time(9), KST).timestamp()*1000)
CLOSE = close_ms(DAY)


def snapshot(qty=10, cutoff=CLOSE):
    data = [MinuteBar(OPEN, qty, open=10, high=12, low=9, close=11)]
    return MinuteSnapshot(data, CLOSE + 20_000, chart_bars=data, cutoff_ms=cutoff)


async def test_whole_market_closed_day_survives_repeat_without_512_entry_churn(tmp_path):
    cache = MinuteDayCache()
    calls = 0
    data = [MinuteBar(OPEN + i*60_000, i+1, open=10, high=12, low=9, close=11) for i in range(391)]
    async def load():
        nonlocal calls
        calls += 1
        return MinuteSnapshot(data, CLOSE+20_000, chart_bars=data, cutoff_ms=CLOSE)
    for _ in range(2):
        for code in range(2808):
            await cache.obtain(cache.key(tmp_path, 'KRX', str(code), DAY), CLOSE, load)
    assert calls == 2808
    assert len(cache.entries) == 2808 and cache.evictions == 0
    assert cache.bytes < 64*1024*1024


async def test_live_cutoffs_reuse_older_observation_but_never_future_partial_values(tmp_path):
    cache = MinuteDayCache()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    now = OPEN + 20_000
    first = replace(snapshot(cutoff=now), fetched_at_ms=now)
    cache.put(key, first, now)
    assert cache.get(key, now+1000, now_ms=now+1000).bars[0].volume == 10
    assert cache.get(key, now-1000, now_ms=now+1000) is None
    assert cache.get(key, now+15_000, now_ms=now+15_000) is None
    assert cache.get(cache.key(tmp_path, 'NXT', '005930', DAY), now, now_ms=now) is None
    assert cache.get(cache.key(tmp_path/'other', 'KRX', '005930', DAY), now, now_ms=now) is None


async def test_identical_inflight_requests_share_one_load_and_cancellation_is_local(tmp_path):
    cache, began, release = MinuteDayCache(), asyncio.Event(), asyncio.Event()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    calls = 0
    async def load():
        nonlocal calls
        calls += 1
        began.set()
        await release.wait()
        return snapshot()
    first = asyncio.create_task(cache.obtain(key, CLOSE, load))
    await began.wait()
    second = asyncio.create_task(cache.obtain(key, CLOSE, load))
    await asyncio.sleep(0)
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    release.set()
    assert (await second).bars[0].volume == 10
    assert calls == 1 and not cache.flights


async def test_repair_fences_old_inflight_response_and_errors_do_not_poison_cache(tmp_path):
    cache, began, release = MinuteDayCache(), asyncio.Event(), asyncio.Event()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    async def old():
        began.set()
        await release.wait()
        return snapshot(10)
    async def fresh():
        return snapshot(20)
    task = asyncio.create_task(cache.obtain(key, CLOSE, old))
    await began.wait()
    assert (await cache.obtain(key, CLOSE, fresh, force=True)).bars[0].volume == 20
    release.set()
    await task
    assert cache.get(key, CLOSE).bars[0].volume == 20
    assert not cache.serials and not cache.flights
    async def failed():
        return MinuteSnapshot([], CLOSE, 'invalid_rows')
    await cache.obtain(key, CLOSE, failed, force=True)
    assert cache.get(key, CLOSE) is None
    assert (await cache.obtain(key, CLOSE, fresh)).bars[0].volume == 20


def test_compact_roundtrip_is_isolated_and_budgeted(tmp_path):
    cache = MinuteDayCache(max_entries=2)
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    source = snapshot()
    source.bars[0] = replace(source.bars[0], trade_value_won=123.5, previous_day_close=9, previous_day_ms=OPEN-86400000)
    source.chart_bars = source.bars
    cache.put(key, source, CLOSE)
    read = cache.get(key, CLOSE)
    assert read.bars == source.bars
    read.bars.clear()
    assert cache.get(key, CLOSE).bars == source.bars
    for code in ('000660', '000001'):
        cache.put(cache.key(tmp_path, 'KRX', code, DAY), snapshot(), CLOSE)
    assert cache.get(key, CLOSE) is None and cache.evictions == 1
    assert cache.bytes == sum(value.weight for value in cache.entries.values())
    cache.clear()
    assert not cache.entries and cache.bytes == 0


def test_full_session_rows_do_not_leak_future_minutes_or_other_sessions_into_regular_search(tmp_path):
    cache = MinuteDayCache()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    data = [MinuteBar(OPEN-60_000, 1), MinuteBar(OPEN, 2), MinuteBar(OPEN+60_000, 9999)]
    cache.put(key, MinuteSnapshot(data, OPEN+20_000, chart_bars=data, cutoff_ms=OPEN+20_000), OPEN+20_000)
    regular = cache.get(key, OPEN+20_000, now_ms=OPEN+20_000)
    assert [bar.volume for bar in regular.bars] == [2]
    assert len(regular.chart_bars) == 3
    assert cache.key(tmp_path, 'KRX', '005930', '20261030') == key


async def test_live_load_can_advance_its_observation_once_without_duplicate_fetch(tmp_path):
    cache = MinuteDayCache()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    calls = 0
    async def load():
        nonlocal calls
        calls += 1
        return replace(snapshot(cutoff=OPEN+21_000), fetched_at_ms=OPEN+21_000)
    result = await cache.obtain(key, OPEN+20_000, load, allow_advance=True)
    assert result.cutoff_ms == OPEN+21_000 and calls == 1
    # Advancing live observation is not permission to read from the future.
    assert cache.get(key, OPEN+20_000, now_ms=OPEN+20_000, allow_advance=True) is None


def test_empty_completed_day_is_not_sealed_forever(tmp_path):
    cache = MinuteDayCache()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    cache.put(key, MinuteSnapshot([], CLOSE+20_000, cutoff_ms=CLOSE), CLOSE)
    assert cache.get(key, CLOSE, now_ms=CLOSE+21_000) is not None
    assert cache.get(key, CLOSE, now_ms=CLOSE+40_000) is None


def test_duplicate_provider_timestamp_is_counted_once_in_shared_snapshot(tmp_path):
    cache = MinuteDayCache()
    key = cache.key(tmp_path, 'KRX', '005930', DAY)
    data = [MinuteBar(OPEN, 10), MinuteBar(OPEN, 20)]
    cache.put(key, MinuteSnapshot(data, CLOSE+20_000, chart_bars=data, cutoff_ms=CLOSE), CLOSE)
    assert [bar.volume for bar in cache.get(key, CLOSE).bars] == [20]
