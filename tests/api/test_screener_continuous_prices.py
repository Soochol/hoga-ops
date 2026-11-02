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
    assert bars[0][3:8] == [110, 110, 105, 105, False]
    assert bars[1][3:8] == [120, 130, 115, 115, True]
    assert bars[0][8:] == [OPEN + 20_000, OPEN + 30_000]
    assert bars[1][8:] == [OPEN + MINUTE, now]
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


def assert_saved_result(result, request, codes, data, baseline_ms, now):
    from hoga.api import screener_expression
    from hoga.api.screener_series_runner import _matches

    assert result.coverage.complete == 152
    assert result.coverage.realtime.prepared == 152
    assert result.coverage.realtime.receiving == 152
    expected_passing = {'G'}
    passing = {code: {'G'} for code in codes}
    for leaf in request.conditions[:-1]:
        expected_data = volume.aggregate_day_minutes(data, leaf.params.timeframe, now)
        expected, complete = volume.records(leaf, expected_data, fetched_at_ms=baseline_ms)
        assert complete
        assert result.events[leaf.id] == [(code, event) for code in codes for event in expected]
        if expected:
            expected_passing.add(leaf.id)
        for code, _event in result.events[leaf.id]:
            passing[code].add(leaf.id)
    tokens = screener_expression.parse_expression(request.expression, len(request.conditions))
    expected_match = _matches(tokens, expected_passing, request.conditions)
    assert all(_matches(tokens, passing[code], request.conditions) == expected_match for code in codes)


def full_saved_request():
    request = saved_request()
    by_id = {leaf.id: leaf.model_dump() for leaf in request.conditions}
    return ScanRequest.model_validate(dict(conditions=[by_id[name] for name in 'ABCDEF'] + [
        dict(id='G', type='trade_value_rank', params=dict(top_n=300))],
        expression='((A AND B) OR (C AND D) OR (E AND F)) AND G', basis='intraday',
        calculation_policy='separate_bases_v2', universe=dict(scopes=['watchlist', 'heatmap'])))


async def test_full_152_saved_expression_is_complete_and_warm_reads_fetch_nothing(tmp_path, monkeypatch):
    import asyncio
    from types import SimpleNamespace

    from hoga.api import screener_rankings
    from hoga.api.screener_continuous import ContinuousMonitors
    from hoga.live.buffer import LiveBuffer

    request = full_saved_request()
    assert all(ContinuousAdapter.supports(leaf) for leaf in request.conditions[:-1])
    codes = [f'{i:06d}' for i in range(152)]
    data = minute_fixture()
    baseline_ms = data[-1].start_ms + 20_000
    clock = SimpleNamespace(now=baseline_ms)
    calls = []
    buffer = LiveBuffer()
    buffer.volume_source.configure(codes)
    buffer.volume_source.health(dict.fromkeys(codes, 'account:1'), OPEN)

    async def targets(_codes):
        for frame in buffer.volume_source.frames(clock.now):
            buffer.volume_replica.apply(frame, clock.now)

    async def loader(_dir, code, timeframe, _needed, _lower, _asof):
        calls.append((code, timeframe))
        return volume.MinuteSnapshot(list(data), baseline_ms)

    async def forbidden(*args, **kwargs):
        pytest.fail('result read initiated a vendor fetch')

    owner = ContinuousMonitors(tmp_path, None, buffer, targets, loader=loader, now=lambda: clock.now)

    async def resolve(_request):
        return codes

    owner.resolve = resolve
    monkeypatch.setattr(volume, 'minute_snapshot', forbidden)
    monkeypatch.setattr(volume.time, 'time', lambda: clock.now / 1000)
    try:
        status = await owner.start('saved', request)
        owner.loop_task.cancel()
        await asyncio.gather(owner.loop_task, return_exceptions=True)
        owner.loop_task = None
        monitor = owner.get(status.id)
        await targets(codes)
        for code in codes:
            await owner.prepare(code, owner.histories[code])
        rank = SimpleNamespace(events={'G': [(code, None) for code in codes]})
        candidates = screener_rankings.candidate_codes(request, codes, rank)
        assert candidates == codes
        for _ in range(2):
            await targets(codes)
            result = await volume.evaluate(data_dir=tmp_path, conditions=request.conditions, codes=candidates,
                basis='intraday', now=dt.datetime.fromtimestamp(clock.now / 1000, KST),
                volume_runtime=ContinuousAdapter(owner, monitor))
            assert_saved_result(result, request, codes, data, baseline_ms, clock.now)
            assert len(calls) == 152
            assert {timeframe for _code, timeframe in calls} == {'1m'}
            clock.now += 16_000
    finally:
        await owner.close()


@pytest.mark.parametrize('bad_price', [None, True, 0, -1, '100', float('inf'), float('nan')])
def test_bad_trade_price_preserves_volume_but_cannot_certify_ohlc(bad_price):
    source = VolumeSource('prices')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN)
    source.ingest(CODE, trade(OPEN, 1, 100), OPEN)
    source.ingest(CODE, trade(OPEN + MINUTE, 2, bad_price), OPEN + MINUTE)
    row = source.frames(OPEN + MINUTE)[0]['streams'][CODE]['bars'][-1]
    assert row[1:3] == [1, True]
    assert row[7] is False


def test_cumulative_gap_can_repair_volume_without_recovering_missed_trade_prices():
    source = VolumeSource('prices')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN)
    source.ingest(CODE, trade(OPEN, 1, 100), OPEN)
    source.ingest(CODE, trade(OPEN + MINUTE, 2, 110), OPEN + MINUTE)
    source.ingest(CODE, trade(OPEN + MINUTE + 1000, 20, 120), OPEN + MINUTE + 1000)
    row = source.frames(OPEN + MINUTE + 1000)[0]['streams'][CODE]['bars'][-1]
    assert row[1] == 19
    assert row[7] is False


def test_source_prices_never_claim_an_unobserved_first_minute_prefix():
    source = VolumeSource('prices')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN)
    source.ingest(CODE, trade(OPEN + 1000, 100, 110), OPEN + 1000)
    row = source.frames(OPEN + 1000)[0]['streams'][CODE]['bars'][-1]
    assert row[3:8] == [110, 110, 110, 110, False]
