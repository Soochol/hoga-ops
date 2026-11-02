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
    assert all(ContinuousAdapter.eligible(leaf) for leaf in request.conditions)
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
    assert all(ContinuousAdapter.eligible(leaf) for leaf in request.conditions[:-1])
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


@pytest.fixture
async def live_prices(tmp_path):
    import asyncio
    from types import SimpleNamespace

    from hoga.api.screener_continuous import ContinuousMonitors
    from hoga.live.buffer import LiveBuffer

    rows = minute_fixture()
    clock = SimpleNamespace(now=rows[-1].start_ms + 20_000)
    calls = []
    source = VolumeSource('live-prices')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN)
    source.ingest(CODE, trade(OPEN + 179 * MINUTE, 10_000), OPEN + 179 * MINUTE)
    cum = 10_000
    for offset, price, qty in [(0, 2800, 1), (5000, 2812, 1), (10_000, 2795, 1), (15_000, 2809, 187)]:
        stamp = rows[-1].start_ms + offset
        cum += qty
        source.ingest(CODE, trade(stamp, cum, price, qty), stamp)
    buffer = LiveBuffer()
    buffer.volume_replica.reset('live-prices')

    async def targets(_codes):
        if not _codes:
            return
        for frame in source.frames(clock.now):
            buffer.volume_replica.apply(frame, clock.now)

    async def loader(*_args, **_kwargs):
        calls.append(clock.now)
        return volume.MinuteSnapshot(list(rows), clock.now)

    owner = ContinuousMonitors(tmp_path, None, buffer, targets, loader=loader, now=lambda: clock.now)

    async def resolve(_request):
        return [CODE]

    owner.resolve = resolve
    status = await owner.start('live', full_saved_request())
    owner.loop_task.cancel()
    await asyncio.gather(owner.loop_task, return_exceptions=True)
    owner.loop_task = None
    monitor = owner.get(status.id)
    await targets([CODE])
    await owner.prepare(CODE, owner.histories[CODE])
    yield SimpleNamespace(owner=owner, source=source, clock=clock, calls=calls, rows=rows,
                          monitor=monitor, targets=targets, cum=cum)
    await owner.close()


async def push_price(fixture, *, price=3000, qty=5, advance=1000):
    fixture.clock.now += advance
    fixture.cum += qty
    fixture.source.ingest(CODE, trade(fixture.clock.now, fixture.cum, price, qty), fixture.clock.now)
    await fixture.targets([CODE])
    fixture.owner.merge(CODE, fixture.owner.histories[CODE], fixture.clock.now)


def assert_leaf_parity(leaf, result, rows, now, observed):
    expected = volume.aggregate_day_minutes(rows, leaf.params.timeframe, now)
    events, complete = volume.records(leaf, expected, fetched_at_ms=observed)
    assert result[2:] == (events, complete, None)


async def test_ws_price_replaces_seed_and_one_snapshot_serves_all_six_leaves(live_prices):
    s = live_prices
    baseline_ms = s.clock.now
    adapter = ContinuousAdapter(s.owner, s.monitor)
    first = await adapter.evaluate_leaf(s.monitor.leaves[0], CODE, s.clock.now)
    assert_leaf_parity(s.monitor.leaves[0], first, s.rows, s.clock.now, baseline_ms)
    await push_price(s)
    old_rows = list(s.rows)
    s.rows[-1] = replace(s.rows[-1], volume=195, high=3000, close=3000)
    for leaf in s.monitor.leaves[1:]:
        frozen = await adapter.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, frozen, old_rows, s.clock.now, baseline_ms)
    history = s.owner.histories[CODE]
    assert history.bars[-1] == s.rows[-1]
    fresh = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await fresh.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, s.clock.now)
    assert s.owner.status(s.monitor, s.clock.now).receiving == 1
    assert len(s.calls) == 1


async def test_healthy_quiet_stream_keeps_actual_price_observation_time_without_refetch(live_prices):
    s = live_prices
    await push_price(s)
    observed = s.clock.now
    s.rows[-1] = replace(s.rows[-1], volume=195, high=3000, close=3000)
    s.clock.now += 16_000
    await s.targets([CODE])
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await adapter.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, observed)
    assert s.owner.status(s.monitor, s.clock.now).receiving == 1
    s.owner.schedule({CODE}, s.clock.now)
    assert not s.owner.pending
    assert len(s.calls) == 1


async def test_incomplete_source_prefix_holds_prices_until_settled_canonical_repair(live_prices):
    s = live_prices
    s.source.health({CODE: 'account:2'}, s.clock.now + 1000)
    await push_price(s)
    history = s.owner.histories[CODE]
    assert not prices.valid_prices(history.bars[-1])
    adapter = ContinuousAdapter(s.owner, s.monitor)
    leaf = next(leaf for leaf in s.monitor.leaves if leaf.id == 'B')
    assert not (await adapter.evaluate_leaf(leaf, CODE, s.clock.now))[3]
    assert s.owner.status(s.monitor, s.clock.now).receiving == 0
    s.rows[-1] = replace(s.rows[-1], volume=195, high=3000, close=3000, is_open=False)
    s.clock.now = s.rows[-1].start_ms + MINUTE + 20_000
    await s.targets([CODE])
    s.owner.schedule({CODE}, s.clock.now)
    assert set(s.owner.pending) == {CODE}
    import asyncio
    await asyncio.gather(*s.owner.pending.values())
    repaired = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await repaired.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, s.clock.now)
    assert history.bars[-1].close == 3000
    assert s.owner.status(s.monitor, s.clock.now).receiving == 1
    assert len(s.calls) == 2


async def test_two_hour_replay_loss_cannot_self_clear_without_api_repair(live_prices):
    s = live_prices
    await push_price(s, advance=120 * MINUTE)
    history = s.owner.histories[CODE]
    assert history.repair_until_ms
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        assert not (await adapter.evaluate_leaf(leaf, CODE, s.clock.now))[3]
    assert len(s.calls) == 1
    s.rows[:] = minute_fixture(301)
    s.rows[-1] = replace(s.rows[-1], volume=5, open=3000, high=3000, low=3000, close=3000)
    s.owner.schedule({CODE}, s.clock.now)
    assert set(s.owner.pending) == {CODE}
    import asyncio
    await asyncio.gather(*s.owner.pending.values())
    assert not history.repair_until_ms
    assert len(s.calls) == 2
    assert prices.valid_prices(history.bars[-1])
    fresh = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await fresh.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, s.clock.now)


async def test_sparse_ws_rollover_aggregates_real_prices_without_inventing_quiet_minutes(live_prices):
    s = live_prices
    await push_price(s)
    s.rows[-1] = replace(s.rows[-1], volume=195, high=3000, close=3000, is_open=False)
    next_stamp = OPEN + 183 * MINUTE + 10_000
    await push_price(s, price=3100, qty=7, advance=next_stamp - s.clock.now)
    s.rows.append(volume.VolumeBar(OPEN + 183 * MINUTE, 7, is_open=True,
                                  open=3100, high=3100, low=3100, close=3100))
    history = s.owner.histories[CODE]
    assert [bar.start_ms for bar in history.bars[-2:]] == [OPEN + 180 * MINUTE, OPEN + 183 * MINUTE]
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await adapter.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, s.clock.now)
    s.owner.schedule({CODE}, s.clock.now)
    assert not s.owner.pending
    assert len(s.calls) == 1


async def test_prior_selected_day_price_leaves_keep_adjustment_fallback(live_prices, monkeypatch):
    from hoga.api import screener_bar_threshold

    s = live_prices
    s.clock.now = OPEN + 24 * 60 * MINUTE - 60 * MINUTE
    calendar = s.owner.data_dir / 'calendar'
    calendar.mkdir()
    (calendar / 'trading_days.txt').write_text('20261021\n20261022\n')
    adapter = ContinuousAdapter(s.owner, s.monitor)
    leaf = next(leaf for leaf in s.monitor.leaves if leaf.id == 'B')
    assert not adapter.supports(leaf)
    seen = []

    async def loader(*_args, **_kwargs):
        return volume.MinuteSnapshot([replace(bar, is_open=False) for bar in s.rows], s.clock.now)

    async def adjusted(leaf, data, _dir, code, anchor, operation=None):
        seen.append((leaf.id, code, anchor))
        return [replace(bar, **{name: getattr(bar, name) * 2 for name in prices.PRICE_FIELDS}) for bar in data], None

    monkeypatch.setattr(volume, 'minute_snapshot', loader)
    monkeypatch.setattr(screener_bar_threshold, 'prepare_minutes', adjusted)
    monkeypatch.setattr(volume.time, 'time', lambda: s.clock.now / 1000)
    result = await volume.evaluate(data_dir=s.owner.data_dir, conditions=[leaf], codes=[CODE], basis='intraday',
        now=dt.datetime.fromtimestamp(s.clock.now / 1000, KST), volume_runtime=adapter)
    assert result.coverage.complete == 1
    assert seen == [('B', CODE, '20261022')]
    assert all(event.bar_change_match.close >= 2 * 1000 for _, event in result.events[leaf.id])


@pytest.mark.parametrize('timeframe', ['1m', '3m', '5m', '10m'])
@pytest.mark.parametrize('reference', ['previous_bar', 'bar_open'])
def test_supported_price_only_shapes_have_explicit_bounded_requirements(timeframe, reference):
    req = ScanRequest.model_validate(dict(conditions=[dict(id='price', type='change_pct',
        params=dict(timeframe=timeframe, change_reference=reference, op='gte', pct=1))],
        universe=dict(scopes=['watchlist'])))
    leaf = req.conditions[0]
    assert ContinuousAdapter.eligible(leaf)
    assert candles.candle_count(leaf) == (2 if reference == 'previous_bar' else 1)
    previous_day = leaf.model_copy(update={
        'params': leaf.params.model_copy(update={'change_reference': 'previous_day'})})
    assert not ContinuousAdapter.eligible(previous_day)


async def test_newer_canonical_open_observation_wins_over_older_partial_source(live_prices):
    s = live_prices
    partial = VolumeSource('partial')
    partial.configure({CODE})
    partial.health({CODE: 'partial:1'}, s.rows[-1].start_ms + 5000)
    stamp = s.rows[-1].start_ms + 10_000
    partial.ingest(CODE, trade(stamp, 10_000, 2700), stamp)
    s.owner.replica.reset('partial')
    for frame in partial.frames(s.clock.now):
        s.owner.replica.apply(frame, s.clock.now)
    history = s.owner.histories[CODE]
    s.owner.merge(CODE, history, s.clock.now)
    assert history.bars[-1] == s.rows[-1]
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await adapter.evaluate_leaf(leaf, CODE, s.clock.now)
        assert_leaf_parity(leaf, result, s.rows, s.clock.now, s.clock.now)
    s.clock.now += 1000
    partial.ingest(CODE, trade(s.clock.now, 10_001, 3200), s.clock.now)
    for frame in partial.frames(s.clock.now):
        s.owner.replica.apply(frame, s.clock.now)
    s.owner.merge(CODE, history, s.clock.now)
    assert not prices.valid_prices(history.bars[-1])


async def test_next_open_keeps_price_same_day_shortage_instead_of_using_yesterday(live_prices):
    s = live_prices
    s.clock.now = OPEN + 24 * 60 * MINUTE + 20_000
    next_start = s.clock.now // MINUTE * MINUTE
    s.source.ingest(CODE, trade(s.clock.now, 1, 1000), s.clock.now)
    await s.targets([CODE])
    history = s.owner.histories[CODE]
    s.owner.merge(CODE, history, s.clock.now)
    s.rows[:] = [volume.VolumeBar(next_start, 1, is_open=True, open=1000, high=1000, low=1000, close=1000)]
    await s.owner.prepare(CODE, history)
    assert history.reason == 'insufficient_minute_history'
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await adapter.evaluate_leaf(leaf, CODE, s.clock.now)
        assert result[3:] == (False, 'insufficient_minute_history')
    assert all(bar.start_ms >= next_start for bar in history.bars)
    assert s.owner.status(s.monitor, s.clock.now).receiving == 0
    assert len(s.calls) == 2


async def test_accepted_tick_snapshot_uses_actual_boundary_after_an_earlier_scan_clock(live_prices):
    s = live_prices
    scan_clock = s.clock.now
    await push_price(s, advance=MINUTE)
    snapshot = s.owner.snapshot(CODE, scan_clock)
    assert snapshot.cutoff_ms == s.clock.now
    assert snapshot.observed_ms == s.clock.now
    assert not snapshot.bars[-2].is_open
    assert snapshot.bars[-1].is_open
    assert snapshot.bars[-1].start_ms == OPEN + 181 * MINUTE


def test_admission_accounts_for_replay_and_extra_history_bar():
    from fastapi import HTTPException

    from hoga.api.screener_continuous import (
        BAR_RESERVATION_BYTES,
        MAX_BYTES,
        REPLAY_RESERVATION_BYTES,
        ContinuousMonitors,
    )

    maximum = (MAX_BYTES - REPLAY_RESERVATION_BYTES) // BAR_RESERVATION_BYTES - 1
    ContinuousMonitors.admit({CODE: maximum})
    with pytest.raises(HTTPException):
        ContinuousMonitors.admit({CODE: maximum + 1})
    for count in (350, 512):
        ContinuousMonitors.admit({f'{index:06d}': 79 for index in range(count)})


async def test_source_epoch_and_generation_fence_cached_snapshot_versions(live_prices):
    s = live_prices
    history = s.owner.histories[CODE]
    first = s.owner.version(CODE, history, s.clock.now)
    history.source_epoch = 'replacement'
    second = s.owner.version(CODE, history, s.clock.now)
    history.generation = 'next-registration'
    third = s.owner.version(CODE, history, s.clock.now)
    assert first != second != third


async def test_ignored_closed_replay_cannot_restamp_canonical_prices(live_prices):
    s = live_prices
    history = s.owner.histories[CODE]
    fetched = OPEN + 390 * MINUTE + 20_000
    history.bars = [replace(bar, start_ms=bar.start_ms + 210 * MINUTE, is_open=False) for bar in s.rows]
    history.fetched_ms = history.source_seen_ms = fetched
    history.source_epoch = history.generation = ''
    history.observed.clear()
    history.lower.clear()
    history.canonical = {bar.start_ms: fetched for bar in history.bars}
    history.merge_token = None
    s.clock.now = fetched + 1000
    source = VolumeSource('closed')
    source.configure({CODE})
    source.health({CODE: 'closed:1'}, OPEN)
    source.ingest(CODE, trade(s.clock.now, 10_000, 9999), s.clock.now)
    s.owner.replica.reset('closed')
    for frame in source.frames(s.clock.now):
        s.owner.replica.apply(frame, s.clock.now)
    snapshot = s.owner.snapshot(CODE, s.clock.now)
    assert snapshot.bars[-1].close == s.rows[-1].close
    assert snapshot.observed_ms == fetched
