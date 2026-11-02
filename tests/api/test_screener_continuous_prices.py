"""Saved afternoon leaves use the same bounded OHLCV history as volume."""
import datetime as dt
from dataclasses import replace

import pytest

from hoga.api import screener_bar_price as prices, screener_bar_volume as volume, screener_continuous_bars as candles
from hoga.api.models import ScanRequest
from hoga.api.screener_continuous import ContinuousAdapter, History
from hoga.live.volume_state import MINUTE, VolumeReplica, VolumeSource
from hoga.util.timeenc import KST

OPEN = int(dt.datetime(2026, 10, 21, 9, tzinfo=KST).timestamp() * 1000)
CODE = '005930'


def saved_request():
    conditions = []
    for name, timeframe, period, lookback in [('A', '3m', 20, 3), ('C', '5m', 12, 3), ('E', '10m', 6, 2)]:
        conditions.append(dict(id=name, type='new_high_vol', params=dict(
            timeframe=timeframe, period=period, lookback=lookback)))
    for name, timeframe, lookback in [('B', '3m', 20), ('D', '5m', 12), ('F', '3m', 2)]:
        conditions.append(dict(id=name, type='change_pct_period', params=dict(
            timeframe=timeframe, lookback=lookback, change_reference='previous_bar', op='gte', pct=1)))
    return ScanRequest.model_validate(dict(conditions=conditions, basis='intraday',
        universe=dict(scopes=['watchlist', 'heatmap'])))


def minute_fixture(count=181):
    return [volume.VolumeBar(OPEN + i * MINUTE, 10 + i, is_open=i == count - 1,
        open=1000 + i * 10, high=1012 + i * 10, low=995 + i * 10, close=1009 + i * 10)
        for i in range(count)]


def test_saved_six_leaves_are_owned_by_one_continuous_history():
    request = saved_request()
    assert all(ContinuousAdapter.supports(leaf) for leaf in request.conditions)
    assert [candles.candle_count(leaf) for leaf in request.conditions] == [22, 14, 7, 21, 13, 3]
    assert candles.requirement(request.conditions) == 79


@pytest.mark.parametrize('leaf_index', range(6))
def test_saved_leaf_ohlcv_and_occurrences_equal_canonical_day_grid(leaf_index):
    leaf = saved_request().conditions[leaf_index]
    data = minute_fixture()
    now = data[-1].start_ms + 20_000
    history = History(needed=200, bars=data, fetched_ms=now, coverage_start_ms=OPEN)
    actual, _ = candles.window(history, leaf, now)
    expected = volume.aggregate_day_minutes(data, leaf.params.timeframe, now)
    expected = expected[-(candles.candle_count(leaf) + 1):]
    assert actual == expected
    assert all(prices.valid_prices(bar) for bar in actual)
    assert volume.records(leaf, actual, fetched_at_ms=now) == volume.records(leaf, expected, fetched_at_ms=now)


def trade(stamp, cum, price=100, qty=1):
    return dict(kind='trade', venue='KRX', t_ms=stamp, cum_volume=cum,
        trades=[dict(t_ms=stamp, qty=qty, price=price)])


def test_raw_trade_replay_preserves_ordered_ohlc_and_missing_prefix_is_unknown():
    source = VolumeSource('prices')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN + 10_000)
    for stamp, cum, price in [(OPEN + 20_000, 100, 110), (OPEN + 30_000, 101, 105),
                              (OPEN + MINUTE, 102, 120), (OPEN + MINUTE + 1000, 103, 130),
                              (OPEN + MINUTE + 2000, 104, 115)]:
        source.ingest(CODE, trade(stamp, cum, price), stamp)
    replica = VolumeReplica()
    replica.reset('prices')
    now = OPEN + MINUTE + 2000
    for frame in source.frames(now):
        replica.apply(frame, now)
    bars = replica.get(CODE, now)['bars']
    assert bars[0][3:] == [110, 110, 105, 105, False]
    assert bars[1][3:] == [120, 130, 115, 115, True]
    source.ingest(CODE, trade(now, 104, 999), now)
    assert source.frames(now)[0]['streams'][CODE]['bars'] == bars


def test_missing_ohlc_never_changes_volume_completeness_into_price_completeness():
    leaf = saved_request().conditions[3]
    data = minute_fixture()
    data[-2] = replace(data[-2], open=None, high=None, low=None, close=None)
    history = History(needed=200, bars=data, fetched_ms=1, coverage_start_ms=OPEN)
    grouped, _ = candles.window(history, leaf, data[-1].start_ms + 1000)
    assert not volume.records(leaf, grouped, fetched_at_ms=1)[1]
    assert all(bar.valid for bar in grouped)
