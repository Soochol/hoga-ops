"""Scoped REST seed -> raw KRX WS -> shared multi-minute result/repair."""
import asyncio
import datetime as dt
from dataclasses import replace
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from hoga.api import screener_bar_volume as volume, screener_continuous_bars as candles
from hoga.api.models import ScanRequest
from hoga.api.screener_continuous import ContinuousAdapter, ContinuousMonitors, History
from hoga.live.buffer import LiveBuffer
from hoga.live.volume_state import MINUTE, REPLAY_MS, VolumeSource
from hoga.util.timeenc import KST

OPEN = int(dt.datetime(2026, 10, 21, 9, tzinfo=KST).timestamp() * 1000)
CODE = '005930'


def request(timeframes=('3m', '5m', '10m'), period=3, lookback=1, scopes=None):
    return ScanRequest.model_validate(dict(conditions=[dict(id=tf, type='new_high_vol',
        params=dict(timeframe=tf, period=period, lookback=lookback)) for tf in timeframes],
        universe=dict(scopes=['watchlist', 'heatmap'] if scopes is None else scopes), basis='intraday'))


@pytest.fixture
async def setup(tmp_path):
    clock = SimpleNamespace(now=OPEN + 60 * MINUTE + 20_000)
    calls, targets = [], []
    source = VolumeSource('multi')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, OPEN)
    buffer = LiveBuffer()
    buffer.volume_replica.reset('multi')
    oracle = {OPEN + i * MINUTE: 10 for i in range(61)}

    async def loader(_dir, code, timeframe, needed, _lower, _asof):
        calls.append((code, timeframe, needed))
        data = [volume.VolumeBar(stamp, qty, min(stamp + MINUTE,
                    candles.session_start(stamp) + 390 * MINUTE) > clock.now)
                for stamp, qty in sorted(oracle.items())]
        return volume.MinuteSnapshot(data, clock.now)

    async def set_targets(codes):
        targets.append(codes)

    owner = ContinuousMonitors(tmp_path, SimpleNamespace(publish=lambda event: events.append(event)), buffer,
                               set_targets, loader=loader, now=lambda: clock.now)
    events = []

    async def resolve(_request):
        return [CODE]

    owner.resolve = resolve
    status = await owner.start('multi', request())
    owner.loop_task.cancel()
    await asyncio.gather(owner.loop_task, return_exceptions=True)
    owner.loop_task = None
    monitor = owner.get(status.id)
    yield SimpleNamespace(owner=owner, clock=clock, calls=calls, source=source, oracle=oracle,
                          monitor=monitor, events=events, targets=targets)
    await owner.close()


def ingest(setup, qty, cum):
    source, clock, owner = setup.source, setup.clock, setup.owner
    source.ingest(CODE, dict(kind='trade', venue='KRX', t_ms=clock.now, cum_volume=cum,
                            trades=[dict(t_ms=clock.now, qty=qty)]), clock.now)
    for frame in source.frames(clock.now):
        owner.replica.apply(frame, clock.now)
    owner.merge(CODE, owner.histories[CODE], clock.now)


async def test_three_timeframes_share_one_api_seed_then_cross_on_raw_ws(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    assert s.calls == [(CODE, '1m', 39)]
    ingest(s, 10, 1000)
    adapter = ContinuousAdapter(s.owner, s.monitor)
    s.owner.notify()
    count = len(s.events)
    ingest(s, 300, 1300)
    s.owner.notify()
    assert len(s.events) == count + 1
    for leaf in s.monitor.leaves:
        data, _, lower = adapter.snapshot(leaf, CODE, s.clock.now)
        events, complete = volume.records(leaf, data, fetched_at_ms=s.clock.now)
        assert complete
        assert len(events) == 1
        assert events[0].bar_start_ms == OPEN + 60 * MINUTE
        assert events[0].bar_match.volume == 310
        assert not lower  # Source was healthy before this minute.
    assert adapter.counts(s.monitor.leaves, [CODE], s.clock.now) == (1, 1)
    assert len(s.calls) == 1
    assert s.owner.match_fingerprint(s.monitor, history, s.clock.now)[-1] == (True, True, True)


@pytest.mark.parametrize('timeframe', ['3m', '5m', '10m'])
async def test_result_reads_never_fetch_even_while_preparing(setup, timeframe, monkeypatch):
    s = setup
    leaf = request((timeframe,)).conditions[0]
    monkeypatch.setattr(volume.time, 'time', lambda: s.clock.now / 1000)
    result = await volume.evaluate(data_dir=s.owner.data_dir, conditions=[leaf], codes=[CODE],
        basis='intraday', now=dt.datetime.fromtimestamp(s.clock.now / 1000, KST),
        volume_runtime=ContinuousAdapter(s.owner, s.monitor))
    assert not s.calls
    assert result.coverage.complete == 0
    assert result.coverage.realtime.preparing == 1


async def test_gap_blocks_multiframe_matches_and_only_damaged_code_is_repaired(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    ingest(s, 10, 1000)
    # IPC is absent longer than replay. A missing large comparison cannot be
    # replaced by an old, small baseline or allocated to the latest minute.
    s.clock.now += 20 * MINUTE
    s.oracle.update({OPEN + i * MINUTE: (9999 if i == 75 else 10) for i in range(61, 81)})
    ingest(s, 500, 10_000)
    assert history.repair_until_ms
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        data, _, _ = adapter.snapshot(leaf, CODE, s.clock.now)
        assert not volume.records(leaf, data, fetched_at_ms=s.clock.now)[0]
    s.owner.schedule({CODE}, s.clock.now)
    assert set(s.owner.pending) == {CODE}
    await asyncio.gather(*s.owner.pending.values())
    assert len(s.calls) == 2
    assert not history.repair_until_ms
    for leaf in s.monitor.leaves:
        data, _, _ = adapter.snapshot(leaf, CODE, s.clock.now)
        # Confirm the repaired REST peak is retained in its correct bucket.
        assert max(b.volume for b in data) >= 9999


async def test_new_trading_day_discards_yesterdays_comparison_history(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    ingest(s, 10, 1000)
    s.clock.now = OPEN + 24 * 60 * MINUTE + 1000
    ingest(s, 1000, 1000)
    assert all(b.start_ms >= OPEN + 24 * 60 * MINUTE for b in history.bars)
    assert not history.fetched_ms
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        data, _, _ = adapter.snapshot(leaf, CODE, s.clock.now)
        assert not volume.records(leaf, data, fetched_at_ms=s.clock.now)[1]


async def test_weekend_and_close_use_api_baseline_without_ws(setup):
    s = setup
    s.clock.now = int(dt.datetime(2026, 10, 25, 12, tzinfo=KST).timestamp() * 1000)
    calendar = s.owner.data_dir / 'calendar'
    calendar.mkdir()
    (calendar / 'trading_days.txt').write_text('20261023\n')
    original = list(s.oracle.items())
    s.oracle.clear()
    s.oracle.update({stamp + 2 * 24 * 60 * MINUTE: qty for stamp, qty in original})
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    for leaf in s.monitor.leaves:
        data, _, _ = ContinuousAdapter(s.owner, s.monitor).snapshot(leaf, CODE, s.clock.now)
        assert all(not b.is_open and b.valid for b in data)
        assert volume.records(leaf, data, fetched_at_ms=s.clock.now)[1]
    s.owner.schedule({CODE}, s.clock.now + 10 * MINUTE)
    assert not s.owner.pending


@pytest.mark.parametrize('timeframe', ['3m', '5m', '10m'])
async def test_scope_required_and_eod_not_redirected(setup, timeframe):
    for req in [request((timeframe,), scopes=[]), request((timeframe,)).model_copy(update={'basis': 'eod'})]:
        with pytest.raises(HTTPException) as exc:
            await setup.owner.start('bad', req)
        assert exc.value.status_code == 422


def test_aggregation_alignment_prefix_quality_lookback_and_closing_auction():
    leaf = request(('5m',), period=2, lookback=2).conditions[0]
    data = [volume.VolumeBar(OPEN + i * MINUTE, 1) for i in range(1, 16)]
    history = History(needed=19, bars=data, fetched_ms=1, coverage_start_ms=OPEN + MINUTE)
    grouped, _ = candles.window(history, leaf, OPEN + 15 * MINUTE + 1000)
    assert [b.start_ms for b in grouped] == [OPEN + i * MINUTE for i in [0, 5, 10, 15]]
    assert [b.volume for b in grouped] == [4, 5, 5, 1]
    assert not grouped[0].valid  # The retained prefix cannot be used as a peak.
    assert grouped[-1].is_open
    history.bars[-1] = replace(history.bars[-1], valid=False)
    assert not candles.window(history, leaf, OPEN + 16 * MINUTE)[0][-1].valid
    # Partial startup volume is labelled at the aggregate bucket, then withheld
    # as a finished comparison until API reconciliation.
    history.bars[-1] = replace(history.bars[-1], valid=True)
    history.lower.add(history.bars[-1].start_ms)
    assert candles.window(history, leaf, OPEN + 16 * MINUTE)[1] == {OPEN + 15 * MINUTE}
    assert not candles.window(history, leaf, OPEN + 20 * MINUTE)[0][-1].valid
    history.bars = [volume.VolumeBar(OPEN + 389 * MINUTE, 7), volume.VolumeBar(OPEN + 390 * MINUTE, 90)]
    history.lower.clear()
    grouped, _ = candles.window(history, leaf, OPEN + 390 * MINUTE)
    assert [(b.start_ms, b.volume, b.is_open) for b in grouped] == [
        (OPEN + 385 * MINUTE, 7, False), (OPEN + 390 * MINUTE, 90, False)]


async def test_partial_seed_marks_group_lower_bound_then_repairs_closed_minute(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    s.source.health({CODE: 'account:2'}, s.clock.now)
    ingest(s, 500, 1500)
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        data, _, lower = adapter.snapshot(leaf, CODE, s.clock.now)
        assert lower == {OPEN + 60 * MINUTE}
        assert volume.records(leaf, data, fetched_at_ms=s.clock.now)[0]
    s.oracle[OPEN + 60 * MINUTE] = 500
    s.clock.now += MINUTE
    s.oracle[OPEN + 61 * MINUTE] = 10
    ingest(s, 10, 1510)
    assert s.owner.status(s.monitor, s.clock.now).recovering == 1
    for leaf in s.monitor.leaves:
        data, _, _ = adapter.snapshot(leaf, CODE, s.clock.now)
        assert not volume.records(leaf, data, fetched_at_ms=s.clock.now)[1]
    s.owner.schedule({CODE}, s.clock.now)
    await asyncio.gather(*s.owner.pending.values())
    assert len(s.calls) == 2
    assert s.owner.status(s.monitor, s.clock.now).receiving == 1


async def test_all_day_3_5_10m_oracle_uses_one_seed_and_no_healthy_polling(setup):
    s = setup
    s.monitor.request = request(period=12, lookback=3)
    s.monitor.leaves = list(s.monitor.request.conditions)
    history = s.owner.histories[CODE]
    history.needed = candles.requirement(s.monitor.leaves)
    s.clock.now = OPEN + 1000
    s.oracle.clear()
    await s.owner.prepare(CODE, history)
    cum = 1000
    for minute in range(391):
        s.clock.now = OPEN + minute * MINUTE + 20_000
        qty = (minute * 31) % 117 + 1
        s.oracle[OPEN + minute * MINUTE] = qty
        cum += qty
        ingest(s, qty, cum)
        for leaf in s.monitor.leaves:
            # Independent whole-day oracle: group only actual observed candles,
            # then evaluate each recent candidate against its own trailing peak.
            minutes = int(leaf.params.timeframe[:-1])
            expected = {}
            for stamp, amount in s.oracle.items():
                bucket = OPEN + ((stamp - OPEN) // (minutes * MINUTE)) * minutes * MINUTE
                expected[bucket] = expected.get(bucket, 0) + amount
            rows = sorted(expected.items())
            period, lookback = leaf.params.period, leaf.params.lookback
            starts = {rows[i][0] for i in range(max(period-1, len(rows)-lookback), len(rows))
                      if rows[i][1] >= max(v for _, v in rows[i-period+1:i+1])}
            data, _, _ = ContinuousAdapter(s.owner, s.monitor).snapshot(leaf, CODE, s.clock.now)
            actual, complete = volume.records(leaf, data, fetched_at_ms=s.clock.now)
            assert {event.bar_start_ms for event in actual} == starts
            assert complete == (len(rows) >= period + lookback - 1)
        # A fully healthy mature stream needs neither a seed nor periodic REST.
        if minute >= 140:
            s.owner.schedule({CODE}, s.clock.now)
            assert not s.owner.pending
    assert len(s.calls) == 1
    assert len(history.bars) <= history.needed + 1


async def test_short_long_timeframe_does_not_mark_prepared_short_timeframe_unknown(setup, monkeypatch):
    s = setup
    req = request(period=12)
    s.monitor.leaves = list(req.conditions)
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    ingest(s, 1000, 2000)
    monkeypatch.setattr(volume.time, 'time', lambda: s.clock.now / 1000)
    result = await volume.evaluate(data_dir=s.owner.data_dir, conditions=req.conditions, codes=[CODE],
        basis='intraday', now=dt.datetime.fromtimestamp(s.clock.now / 1000, KST),
        volume_runtime=ContinuousAdapter(s.owner, s.monitor))
    reasons = {item.condition_id: item.reason for item in result.coverage.incomplete}
    assert '3m' not in reasons
    assert '10m' in reasons
    assert len(s.calls) == 1


async def test_preopen_retains_previous_session_and_holiday_uses_last_trading_day(setup):
    s = setup
    calendar = s.owner.data_dir / 'calendar'
    calendar.mkdir()
    (calendar / 'trading_days.txt').write_text('20261021\n20261022\n20261026\n')
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    s.clock.now = OPEN + 24 * 60 * MINUTE - 60 * MINUTE  # next day 08:00
    for leaf in s.monitor.leaves:
        data, _, _ = ContinuousAdapter(s.owner, s.monitor).snapshot(leaf, CODE, s.clock.now)
        assert data and all(b.valid and not b.is_open for b in data[:-1])
    assert s.owner.status(s.monitor, s.clock.now).prepared == 1
    # A known weekday holiday uses the last trading day, even during 09-15h.
    s.clock.now = OPEN + 2 * 24 * 60 * MINUTE + 60 * MINUTE  # Fri 23, omitted holiday
    s.oracle.clear()
    s.oracle.update({OPEN + 24 * 60 * MINUTE + i * MINUTE: 10 for i in range(61)})
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    assert not s.owner.live_clock(s.clock.now)
    for leaf in s.monitor.leaves:
        data, _, _ = ContinuousAdapter(s.owner, s.monitor).snapshot(leaf, CODE, s.clock.now)
        assert data and all(b.valid and not b.is_open for b in data)


async def test_monday_preopen_monitor_uses_friday_then_defers_at_open_without_yesterday(setup, monkeypatch):
    s = setup
    friday = int(dt.datetime(2026, 10, 30, 9, tzinfo=KST).timestamp() * 1000)
    monday = int(dt.datetime(2026, 11, 2, 9, tzinfo=KST).timestamp() * 1000)
    s.clock.now = monday - (7 * 60 + 24) * MINUTE  # Monday 01:36
    calendar = s.owner.data_dir / 'calendar'
    calendar.mkdir()
    (calendar / 'trading_days.txt').write_text('20261030\n20261102\n')
    s.oracle.clear()
    s.oracle.update({friday + i * MINUTE: 10 for i in range(391)})
    seen = []

    async def snapshot(_dir, code, timeframe, scope, *, force=False):
        seen.append((code, timeframe, scope.day.isoformat(), scope.cutoff))
        return volume.MinuteSnapshot([volume.VolumeBar(stamp, qty) for stamp, qty in s.oracle.items()], s.clock.now)

    monkeypatch.setattr(volume, '_day_snapshot', snapshot)
    monkeypatch.setattr(volume.time, 'time', lambda: s.clock.now / 1000)
    s.owner.loader = volume.monitor_day_snapshot
    history = s.owner.histories[CODE]
    s.monitor.leaves = [leaf.model_copy(update={'params': leaf.params.model_copy(
        update={'period': period, 'lookback': 3})})
        for leaf, period in zip(s.monitor.leaves, (40, 24, 12), strict=True)]
    history.needed = candles.requirement(s.monitor.leaves)
    await s.owner.prepare(CODE, history)
    assert seen == [(CODE, '1m', '2026-10-30', dt.datetime(2026, 10, 30, 15, 30, tzinfo=KST))]
    adapter = ContinuousAdapter(s.owner, s.monitor)
    result = await volume.evaluate(data_dir=s.owner.data_dir, conditions=s.monitor.leaves, codes=[CODE],
        basis='intraday', now=dt.datetime.fromtimestamp(s.clock.now / 1000, KST), volume_runtime=adapter)
    assert result.coverage.complete == 1 and result.coverage.trading_date == '2026-10-30'
    assert result.coverage.realtime.prepared == 1 and result.coverage.realtime.receiving == 0
    # The existing response field survives serialization and labels the actual session.
    assert type(result.coverage).model_validate_json(result.coverage.model_dump_json()).trading_date == '2026-10-30'
    s.clock.now = monday - 1000
    s.owner.schedule({CODE}, s.clock.now)
    assert not s.owner.pending and len(seen) == 1
    # With no fresh tick yet, yesterday is still withheld at the opening boundary.
    s.clock.now = monday
    for leaf in s.monitor.leaves:
        assert adapter.snapshot(leaf, CODE, s.clock.now)[0] == []
    assert s.owner.status(s.monitor, s.clock.now).prepared == 0
    s.owner.schedule({CODE}, s.clock.now)
    assert set(s.owner.pending) == {CODE}
    await asyncio.gather(*s.owner.pending.values())
    assert seen[-1][2] == '2026-11-02'
    s.clock.now += 1000
    ingest(s, 1000, 1000)
    assert history.bars and all(b.start_ms >= monday for b in history.bars)
    assert all(not volume.records(leaf, adapter.snapshot(leaf, CODE, s.clock.now)[0],
                                 fetched_at_ms=s.clock.now)[1] for leaf in s.monitor.leaves)


async def test_delayed_old_session_seed_cannot_reintroduce_yesterdays_bars(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    s.clock.now = OPEN + 24 * 60 * MINUTE + 1000
    ingest(s, 1000, 1000)
    await s.owner.prepare(CODE, history)  # loader is still returning yesterday
    assert not history.fetched_ms
    assert len(history.bars) == 1 and history.bars[0].start_ms == OPEN + 24 * 60 * MINUTE


async def test_each_timeframe_boundary_notifies_even_when_last_timeframe_does_not_roll(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    ingest(s, 10, 1000)
    first = s.owner.match_fingerprint(s.monitor, history, s.clock.now)
    s.clock.now = OPEN + 63 * MINUTE + 1000
    ingest(s, 1, 1001)
    second = s.owner.match_fingerprint(s.monitor, history, s.clock.now)
    assert first != second
    assert first[0][-1][0] == second[0][-1][0]  # 10m bucket stayed at 10:00


async def test_after_close_final_auction_is_settled_and_needs_no_live_connection(setup):
    s = setup
    s.clock.now = OPEN + 390 * MINUTE + 20_000
    s.oracle.clear()
    s.oracle.update({OPEN + i * MINUTE: 10 for i in range(391)})
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    assert not s.owner.live_clock(s.clock.now)
    for leaf in s.monitor.leaves:
        data, _, _ = ContinuousAdapter(s.owner, s.monitor).snapshot(leaf, CODE, s.clock.now)
        assert data[-1].start_ms == OPEN + 390 * MINUTE
        assert all(b.valid and not b.is_open for b in data)
        assert volume.records(leaf, data, fetched_at_ms=s.clock.now)[1]
    status = s.owner.status(s.monitor, s.clock.now)
    assert status.prepared == 1 and status.unavailable == 0 and status.receiving == 0


async def test_default_day_loader_requests_one_1m_day_snapshot_for_all_timeframes(setup, monkeypatch):
    s = setup
    seen = []
    async def snapshot(_dir, code, timeframe, scope):
        seen.append((code, timeframe, scope.day.isoformat()))
        return volume.MinuteSnapshot([volume.VolumeBar(stamp, qty, stamp + MINUTE > s.clock.now)
            for stamp, qty in s.oracle.items()], s.clock.now)
    calendar = s.owner.data_dir / 'calendar'
    calendar.mkdir()
    (calendar / 'trading_days.txt').write_text('20261021\n')
    monkeypatch.setattr(volume, '_day_snapshot', snapshot)
    s.owner.loader = volume.monitor_day_snapshot
    await s.owner.prepare(CODE, s.owner.histories[CODE])
    assert seen == [(CODE, '1m', '2026-10-21')]


async def test_disconnected_partial_minute_closes_and_schedules_api_repair(setup):
    s = setup
    history = s.owner.histories[CODE]
    await s.owner.prepare(CODE, history)
    assert history.bars[-1].is_open and history.lower
    s.clock.now += MINUTE
    s.oracle[OPEN + 61 * MINUTE] = 10
    s.owner.merge(CODE, history, s.clock.now)  # no WS frames at all
    assert not history.bars[-1].is_open and not history.bars[-1].valid
    s.owner.schedule({CODE}, s.clock.now)
    assert set(s.owner.pending) == {CODE}
    await asyncio.gather(*s.owner.pending.values())
    assert len(s.calls) == 2


@pytest.mark.parametrize('transition', ['generation', 'replay_gap'])
@pytest.mark.parametrize('settled', [False, True])
async def test_source_transition_after_close_preserves_settled_rest_session(setup, transition, settled):
    s = setup
    closing = OPEN + 390 * MINUTE
    s.clock.now = closing + (20_000 if settled else 14_000)
    s.oracle.clear()
    s.oracle.update({OPEN + i * MINUTE: 10 for i in range(391)})
    for frame in s.source.frames(s.clock.now):
        s.owner.replica.apply(frame, s.clock.now)
    history = s.owner.histories[CODE]
    s.owner.merge(CODE, history, s.clock.now)
    await s.owner.prepare(CODE, history)
    if transition == 'generation':
        s.clock.now += 30_000
        s.source.health({CODE: 'account:2'}, s.clock.now)
    else:
        s.clock.now += REPLAY_MS + MINUTE
    for frame in s.source.frames(s.clock.now):
        s.owner.replica.apply(frame, s.clock.now)
    s.owner.merge(CODE, history, s.clock.now)
    assert bool(history.repair_until_ms) is not settled
    if settled:
        adapter = ContinuousAdapter(s.owner, s.monitor)
        for leaf in s.monitor.leaves:
            data, _, _ = adapter.snapshot(leaf, CODE, s.clock.now)
            assert volume.records(leaf, data, fetched_at_ms=history.fetched_ms)[1]
        assert s.owner.status(s.monitor, s.clock.now).recovering == 0
    assert len(s.calls) == 1
