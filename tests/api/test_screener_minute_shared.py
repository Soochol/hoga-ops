import asyncio
import datetime as dt
from dataclasses import replace
from types import SimpleNamespace

import pytest

from hoga.api import screener_bar_volume as volume
from hoga.api.screener_minute_scope import MinuteScope, bind
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.minute_day_cache import close_ms, shared_days
from hoga.live.past_candles_cache import PastCandlesCache
from hoga.util.timeenc import KST

DAY = dt.date(2026, 10, 30)
OPEN = int(dt.datetime.combine(DAY, dt.time(9), KST).timestamp()*1000)
NOW = dt.datetime.combine(DAY, dt.time(10), KST)


@pytest.fixture
def vendor(monkeypatch):
    calls = []
    rows = [dict(cntr_tm='20261030' + clock, trde_qty=str(index+1), cur_prc='11',
                 open_pric='10', high_pric='12', low_pric='9')
            for index, clock in enumerate(('085900', '090000', '090100', '090200', '090300', '090400', '090500'))]
    class Client:
        async def call(self, api_id, params):
            calls.append(params)
            await asyncio.sleep(0)
            return SimpleNamespace(rows=rows)
    async def capacity(_scheduler, *, fetch_fn, client, **kwargs):
        return await fetch_fn(client)
    monkeypatch.setattr(volume.kiwoom_rest_runtime, 'ensure_rest_client', lambda _: Client())
    monkeypatch.setattr(volume.kiwoom_rest_runtime, 'ensure_scheduler', lambda _: object())
    monkeypatch.setattr(volume.kiwoom_access, 'run_with_capacity', capacity)
    monkeypatch.setattr(volume.time, 'time', lambda: NOW.timestamp())
    return calls, Client()


async def test_all_timeframes_and_fresh_scan_cutoffs_share_one_raw_day(tmp_path, vendor):
    calls, _ = vendor
    cutoff = dt.datetime.combine(DAY, dt.time(15, 30), KST)
    for second in range(2):
        scope = MinuteScope(DAY, NOW+dt.timedelta(seconds=second))
        with bind(scope):
            values = await asyncio.gather(*(volume._day_snapshot(tmp_path, '005930', tf, scope)
                                           for tf in ('1m', '3m', '5m', '10m')))
        assert [len(value.bars) for value in values] == [6, 2, 2, 1]
        assert values[-1].bars[0].volume == sum(range(2, 8))
    assert len(calls) == 1 and calls[0]['tic_scope'] == '1'
    assert shared_days.get(shared_days.key(tmp_path, 'KRX', '005930', DAY), int(cutoff.timestamp()*1000))


async def test_chart_then_search_and_search_then_chart_reuse_same_raw_source(tmp_path, vendor):
    calls, client = vendor
    chart = LiveMinuteCandleBackfill(data_dir=tmp_path, cache=PastCandlesCache(tmp_path), scheduler=object())
    chart_rows = await chart._shared_today(client, 'KRX', '005930', DAY.strftime('%Y%m%d'))
    assert len(chart_rows) == 7  # Chart keeps the preopen row; search is regular only.
    scope = MinuteScope(DAY, NOW)
    with bind(scope):
        read = await volume._day_snapshot(tmp_path, '005930', '5m', scope)
    assert len(read.bars) == 2 and len(calls) == 1
    scope = MinuteScope(DAY, NOW)
    with bind(scope):
        await volume._day_snapshot(tmp_path, '000660', '3m', scope)
    rows = await chart._shared_today(client, 'KRX', '000660', DAY.strftime('%Y%m%d'))
    assert len(rows) == 7 and len(calls) == 2


async def test_repair_bypasses_fresh_cached_snapshot_and_other_markets_remain_separate(tmp_path, vendor):
    calls, client = vendor
    scope = MinuteScope(DAY, NOW)
    with bind(scope):
        await volume._day_snapshot(tmp_path, '005930', '1m', scope)
    with bind(replace(scope, snapshots={})):
        await volume._day_snapshot(tmp_path, '005930', '1m', replace(scope, snapshots={}), force=True)
    assert len(calls) == 2
    chart = LiveMinuteCandleBackfill(data_dir=tmp_path, cache=PastCandlesCache(tmp_path), scheduler=object())
    await chart._shared_today(client, 'NXT', '005930', DAY.strftime('%Y%m%d'))
    assert len(calls) == 3 and calls[-1]['stk_cd'].endswith('_NX')


def test_resampling_preserves_ohlcv_partial_bar_and_auction_quality():
    data = [volume.VolumeBar(OPEN+i*60_000, i+1, open=10+i, high=12+i, low=9+i, close=11+i)
            for i in range(6)]
    grouped = volume.aggregate_day_minutes(data, '5m', OPEN+5*60_000+1000)
    assert (grouped[0].open, grouped[0].high, grouped[0].low, grouped[0].close, grouped[0].volume) == (10,16,9,15,15)
    assert not grouped[0].is_open and grouped[1].is_open
    data[2] = replace(data[2], valid=False)
    assert not volume.aggregate_day_minutes(data, '5m', OPEN+5*60_000)[0].valid
    closing = close_ms(DAY)
    grouped = volume.aggregate_day_minutes([volume.VolumeBar(closing, 90)], '10m', closing)
    assert grouped[0].volume == 90 and not grouped[0].is_open


async def test_rest_bypass_uses_shared_data_and_never_loads_missing_data(tmp_path, vendor, monkeypatch):
    calls, client = vendor
    scope = MinuteScope(DAY, NOW)
    with bind(scope):
        await volume._day_snapshot(tmp_path, '005930', '1m', scope)
    monkeypatch.setattr(volume.settings, 'rest_bypass_enabled', lambda _: True)
    with bind(replace(scope, snapshots={})):
        warm = await volume._day_snapshot(tmp_path, '005930', '5m', replace(scope, snapshots={}))
        cold = await volume._day_snapshot(tmp_path, '000660', '5m', replace(scope, snapshots={}))
    assert warm.bars and cold.reason == 'rest_bypassed'
    chart = LiveMinuteCandleBackfill(data_dir=tmp_path, cache=PastCandlesCache(tmp_path), scheduler=object())
    read = await chart.collect_minute_cache_only(code='005930', frm=DAY, too=DAY, today_d=DAY, policy='KRX')
    assert read.candles and len(calls) == 1


async def test_invalid_chart_page_cannot_seed_a_false_complete_search(tmp_path, vendor):
    _calls, _client = vendor
    class BadClient:
        async def call(self, *args):
            return SimpleNamespace(rows=[dict(cntr_tm='20261030090000', trde_qty='bad',
                cur_prc='11', open_pric='10', high_pric='12', low_pric='9')])
    chart = LiveMinuteCandleBackfill(data_dir=tmp_path, cache=PastCandlesCache(tmp_path), scheduler=object())
    with pytest.raises(ValueError, match='invalid_rows'):
        await chart._shared_today(BadClient(), 'KRX', '005930', DAY.strftime('%Y%m%d'))
    assert shared_days.get(shared_days.key(tmp_path, 'KRX', '005930', DAY), int(NOW.timestamp()*1000)) is None


async def test_chart_seed_closes_the_1530_auction_for_regular_search(tmp_path, vendor, monkeypatch):
    _calls, _client = vendor
    now_ms = close_ms(DAY)+20_000
    monkeypatch.setattr(volume.time, 'time', lambda: now_ms/1000)
    class ClosingClient:
        async def call(self, *args):
            return SimpleNamespace(rows=[dict(cntr_tm='20261030153000', trde_qty='100',
                cur_prc='11', open_pric='10', high_pric='12', low_pric='9')])
    chart = LiveMinuteCandleBackfill(data_dir=tmp_path, cache=PastCandlesCache(tmp_path), scheduler=object())
    await chart._shared_today(ClosingClient(), 'KRX', '005930', DAY.strftime('%Y%m%d'))
    scope = MinuteScope(DAY, dt.datetime.combine(DAY, dt.time(15, 30), KST))
    with bind(scope):
        result = await volume._day_snapshot(tmp_path, '005930', '1m', scope)
    assert len(result.bars) == 1 and not result.bars[0].is_open and result.bars[0].valid
