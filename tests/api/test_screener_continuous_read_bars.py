import asyncio
import datetime as dt
from collections import Counter
from types import SimpleNamespace

import pytest

from hoga.api import screener_bar_volume as volume, screener_continuous_bars as candles
from hoga.api.screener_continuous import ContinuousAdapter, ContinuousMonitors
from hoga.live.buffer import LiveBuffer
from hoga.live.volume_state import MINUTE
from hoga.util.timeenc import KST
from tests.api.test_screener_continuous_prices import OPEN, full_saved_request, minute_fixture


@pytest.fixture
async def prepared_read(tmp_path, monkeypatch):
    request = full_saved_request()
    codes = ['000660', '005930']
    data = minute_fixture()
    clock = SimpleNamespace(now=data[-1].start_ms + 20_000)
    calls = []
    buffer = LiveBuffer()
    buffer.volume_source.configure(codes)
    buffer.volume_source.health(dict.fromkeys(codes, 'account:1'), OPEN)

    async def targets(_codes):
        for frame in buffer.volume_source.frames(clock.now):
            buffer.volume_replica.apply(frame, clock.now)

    async def loader(_dir, code, timeframe, _needed, _lower, _asof):
        calls.append((code, timeframe))
        return volume.MinuteSnapshot(list(data), clock.now)

    async def forbidden(*_args, **_kwargs):
        pytest.fail('result read initiated a vendor fetch')

    owner = ContinuousMonitors(tmp_path, None, buffer, targets, loader=loader, now=lambda: clock.now)

    async def resolve(_request):
        return codes

    owner.resolve = resolve
    monkeypatch.setattr(volume, 'minute_snapshot', forbidden)
    monkeypatch.setattr(volume.time, 'time', lambda: clock.now / 1000)
    status = await owner.start('read-bars', request)
    owner.loop_task.cancel()
    await asyncio.gather(owner.loop_task, return_exceptions=True)
    owner.loop_task = None
    monitor = owner.get(status.id)
    await targets(codes)
    for code in codes:
        await owner.prepare(code, owner.histories[code])
    yield SimpleNamespace(owner=owner, monitor=monitor, clock=clock, calls=calls, data=data, codes=codes)
    await owner.close()


async def evaluate(s, adapter=None):
    return await volume.evaluate(data_dir=s.owner.data_dir, conditions=s.monitor.request.conditions,
        codes=s.codes, basis='intraday', now=dt.datetime.fromtimestamp(s.clock.now / 1000, KST),
        volume_runtime=adapter or ContinuousAdapter(s.owner, s.monitor))


def payload(result):
    return {'coverage': result.coverage.model_dump(mode='json'),
        'events': {key: [(code, event.model_dump(mode='json')) for code, event in values]
                   for key, values in result.events.items()}}


@pytest.mark.parametrize('changed', [False, True])
async def test_each_read_constructs_once_per_snapshot_timeframe_cutoff_with_full_payload_parity(
        prepared_read, monkeypatch, changed):
    s = prepared_read
    expected = payload(await evaluate(s))
    original, built = candles.aggregate, Counter()
    snapshots = []

    def counted(snapshot, leaf, now):
        snapshots.append(snapshot)
        built[id(snapshot), leaf.params.timeframe, now] += 1
        return original(snapshot, leaf, now)

    monkeypatch.setattr(candles, 'aggregate', counted)
    for _ in range(2):
        if changed:
            for history in s.owner.histories.values():
                history.revision += 1
        assert payload(await evaluate(s)) == expected
    assert len(built) == 2 * len(s.codes) * 3
    assert set(built.values()) == {1}
    assert s.calls == [(code, '1m') for code in s.codes]


def snapshot_variant(snapshot, name):
    from dataclasses import replace

    changes = {
        'lower_bound_open': dict(lower=frozenset([snapshot.bars[-1].start_ms])),
        'lower_bound_closed': dict(lower=frozenset([snapshot.bars[-3].start_ms])),
        'prefix_cut': dict(coverage_start_ms=snapshot.bars[1].start_ms),
        'insufficient': dict(bars=snapshot.bars[-2:]),
        'repair': dict(repair_until_ms=snapshot.cutoff_ms),
        'no_baseline': dict(fetched_ms=0),
        'not_current': dict(current_day=False),
        'unavailable': dict(live_ready=False),
    }.get(name, {})
    if name in {'invalid_minute', 'unknown_prices'}:
        data = list(snapshot.bars)
        prices = dict(valid=False) if name == 'invalid_minute' else dict(open=None, high=None, low=None, close=None)
        data[-3] = replace(data[-3], **prices)
        changes['bars'] = tuple(data)
    return replace(snapshot, **changes)


@pytest.mark.parametrize('variant', ['valid', 'lower_bound_open', 'lower_bound_closed', 'prefix_cut',
    'insufficient', 'repair', 'no_baseline', 'not_current', 'unavailable', 'invalid_minute', 'unknown_prices'])
async def test_six_leaf_quality_matrix_matches_uncached_complete_payload_and_all_cutoffs(
        prepared_read, monkeypatch, variant):
    from dataclasses import replace

    s = prepared_read
    snapshots = {code: snapshot_variant(s.owner.snapshot(code, s.clock.now), variant) for code in s.codes}
    selected = {}
    monkeypatch.setattr(s.owner, 'snapshot', lambda code, _now: selected[code])
    read = candles.ReadBars()
    for stamp in (s.clock.now, s.clock.now + MINUTE, s.clock.now):
        for code, snapshot in snapshots.items():
            for leaf in s.monitor.leaves:
                expected = candles.window(snapshot, leaf, stamp)
                actual = read.window(snapshot, leaf, stamp)
                assert actual == expected
                assert volume.records(leaf, actual[0], fetched_at_ms=snapshot.observed_ms) == volume.records(
                    leaf, expected[0], fetched_at_ms=snapshot.observed_ms)
            assert read.prepared(snapshot, s.monitor.leaves, stamp) == candles.prepared(
                snapshot, s.monitor.leaves, stamp)
            assert read.damaged(snapshot, s.monitor.leaves, stamp) == candles.damaged(snapshot, s.monitor.leaves, stamp)
            selected[code] = replace(snapshot, cutoff_ms=stamp, version=('matrix', stamp))
        uncached = ContinuousAdapter(s.owner, s.monitor)
        uncached._bars = candles
        s.owner.evaluations.clear()
        s.owner._event_count = 0
        expected = payload(await evaluate(s, uncached))
        s.owner.evaluations.clear()
        s.owner._event_count = 0
        assert payload(await evaluate(s)) == expected


def test_immutable_aggregate_and_mutable_window_boundaries_do_not_share_containers():
    from dataclasses import FrozenInstanceError

    from hoga.api.screener_continuous import PreparedSnapshot

    data = minute_fixture()[-80:]
    now = data[-1].start_ms + 20_000
    snapshot = PreparedSnapshot(tuple(data), frozenset([data[-1].start_ms]), data[0].start_ms,
        now, now + 123, ('version',), True, None, now, True, 0)
    leaf = full_saved_request().conditions[0]
    read = candles.ReadBars()
    immutable, lower = read.aggregate(snapshot, leaf, now)
    assert isinstance(immutable, tuple) and isinstance(lower, frozenset)
    first, bounds = read.window(snapshot, leaf, now)
    expected = candles.window(snapshot, leaf, now)
    first.clear()
    bounds.clear()
    assert read.window(snapshot, leaf, now) == expected
    with pytest.raises(FrozenInstanceError):
        immutable[-1].volume = 0


async def test_history_mutation_between_reads_creates_fresh_snapshot_and_memo(prepared_read):
    from dataclasses import replace

    s = prepared_read
    first = ContinuousAdapter(s.owner, s.monitor)
    before = payload(await evaluate(s, first))
    history = s.owner.histories[s.codes[0]]
    history.bars[-1] = replace(history.bars[-1], volume=10_000)
    history.revision += 1
    second = ContinuousAdapter(s.owner, s.monitor)
    after = payload(await evaluate(s, second))
    assert before != after
    assert first._bars is not second._bars
    assert first._snapshots[s.codes[0]] is not second._snapshots[s.codes[0]]
    assert first._snapshots[s.codes[0]].bars[-1].volume != second._snapshots[s.codes[0]].bars[-1].volume
    assert payload(await evaluate(s, first)) == before
    assert s.calls == [(code, '1m') for code in s.codes]


@pytest.mark.parametrize('timeframe', ['1m', '3m', '5m', '10m'])
def test_cutoff_and_close_boundaries_use_actual_time_even_for_one_snapshot(timeframe):
    from dataclasses import replace

    from hoga.api.screener_continuous import PreparedSnapshot

    data = minute_fixture(390)[-80:]
    closing = OPEN + 390 * MINUTE
    snapshot = PreparedSnapshot(tuple(data), frozenset([data[-1].start_ms]), data[0].start_ms,
        closing - MINUTE, closing - 123, ('same-version',), True, None, closing, True, 0)
    leaf = full_saved_request().conditions[0]
    leaf = leaf.model_copy(update={'params': leaf.params.model_copy(update={'timeframe': timeframe})})
    read = candles.ReadBars()
    for stamp in (closing - 1, closing, closing + 1, closing - 1):
        assert read.window(snapshot, leaf, stamp) == candles.window(snapshot, leaf, stamp)
    before = read.aggregate(snapshot, leaf, closing - 1)[0][-1]
    after = read.aggregate(snapshot, leaf, closing)[0][-1]
    if timeframe != '1m':
        assert before.is_open and not after.is_open
        assert before.valid and not after.valid
    other = replace(snapshot, bars=tuple(replace(bar, volume=bar.volume + 1) for bar in snapshot.bars))
    assert read.aggregate(other, leaf, closing) != read.aggregate(snapshot, leaf, closing)


async def test_cancelled_result_retains_shared_evaluation_memo_until_surviving_result_finishes(
        prepared_read, monkeypatch):
    import gc
    import weakref
    from dataclasses import replace

    from hoga.api import screener_continuous, screener_runner
    from hoga.api.models import ScreenerResponse

    s = prepared_read
    expected = payload(await evaluate(s))
    s.owner.evaluations.clear()
    s.owner._event_count = 0
    other = replace(s.monitor, id='other', client_id='other')
    s.owner.monitors[other.id] = other
    entered, release, all_reading = asyncio.Event(), asyncio.Event(), asyncio.Event()
    refs, completed = [], []
    calls = 0
    original_sync = screener_continuous.run_read_sync
    original_leaf = ContinuousAdapter.evaluate_leaf

    async def blocked_records(*args, **kwargs):
        entered.set()
        await release.wait()
        return await original_sync(*args, **kwargs)

    async def leaf_read(self, *args, **kwargs):
        nonlocal calls
        calls += 1
        if calls == 2 * len(s.codes) * len(s.monitor.leaves):
            all_reading.set()
        return await original_leaf(self, *args, **kwargs)

    async def scan(*, volume_runtime, **kwargs):
        refs.append(weakref.ref(volume_runtime._bars))
        completed.append(payload(await evaluate(s, volume_runtime)))
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_continuous, 'run_read_sync', blocked_records)
    monkeypatch.setattr(ContinuousAdapter, 'evaluate_leaf', leaf_read)
    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    first = asyncio.create_task(s.owner.result(s.monitor.id))
    await asyncio.wait_for(entered.wait(), 2)
    second = asyncio.create_task(s.owner.result(other.id))
    await asyncio.wait_for(all_reading.wait(), 2)
    first_scan = s.monitor.result_flight.task
    first.cancel()
    with pytest.raises(asyncio.CancelledError):
        await first
    await asyncio.gather(first_scan, return_exceptions=True)
    assert refs[0]() is not None
    assert len(s.owner.evaluation_flights) == len(s.codes) * len(s.monitor.leaves)
    release.set()
    assert (await second).status == 'ok'
    assert completed == [expected]
    assert s.calls == [(code, '1m') for code in s.codes]
    del first, first_scan, second
    for _ in range(3):
        await asyncio.sleep(0)
    gc.collect()
    assert not s.owner.evaluation_flights
    assert all(ref() is None for ref in refs)


async def test_completed_read_releases_memo_and_pinned_snapshots(prepared_read):
    import gc
    import weakref

    s = prepared_read

    async def read():
        adapter = ContinuousAdapter(s.owner, s.monitor)
        await evaluate(s, adapter)
        return weakref.ref(adapter._bars), [weakref.ref(snapshot) for snapshot in adapter._snapshots.values()]

    memo, snapshots = await read()
    for _ in range(3):
        await asyncio.sleep(0)
    gc.collect()
    assert memo() is None
    assert all(snapshot() is None for snapshot in snapshots)


@pytest.mark.parametrize('quality', ['equal_volume_conflict', 'gap'])
async def test_conflict_and_gap_preserve_unknown_results_for_all_six_leaves(prepared_read, monkeypatch, quality):
    from dataclasses import replace

    s = prepared_read
    snapshot = s.owner.snapshot(s.codes[0], s.clock.now)
    data = list(snapshot.bars)
    if quality == 'equal_volume_conflict':
        old = data[-3]
        data[-3] = candles.ordered_minute_bar(old, replace(old, high=old.high + 100, close=old.close + 100))
        assert not data[-3].valid and data[-3].close is None
    else:
        data = [replace(bar, valid=False) for bar in data]
    snapshot = replace(snapshot, bars=tuple(data), repair_until_ms=s.clock.now)
    monkeypatch.setattr(s.owner, 'snapshot', lambda _code, _now: snapshot)
    baseline = ContinuousAdapter(s.owner, s.monitor)
    baseline._bars = candles
    expected = payload(await evaluate(s, baseline))
    s.owner.evaluations.clear()
    s.owner._event_count = 0
    assert payload(await evaluate(s)) == expected
    assert expected['coverage']['complete'] == 0
    if quality == 'gap':
        assert not any(expected['events'].values())
    else:
        for leaf in s.monitor.leaves:
            interval = int(leaf.params.timeframe[:-1]) * MINUTE
            affected = OPEN + (data[-3].start_ms - OPEN) // interval * interval
            assert all(event['bar_start_ms'] != affected for _code, event in expected['events'][leaf.id])


async def test_evaluation_keeps_actual_observation_time_separate_from_cutoff_and_request_clock(
        prepared_read, monkeypatch):
    from dataclasses import replace

    s = prepared_read
    snapshot = replace(s.owner.snapshot(s.codes[0], s.clock.now), observed_ms=s.clock.now - 123,
        cutoff_ms=s.clock.now + MINUTE)
    monkeypatch.setattr(s.owner, 'snapshot', lambda _code, _now: snapshot)
    adapter = ContinuousAdapter(s.owner, s.monitor)
    for leaf in s.monitor.leaves:
        result = await adapter.evaluate_leaf(leaf, s.codes[0], s.clock.now - MINUTE)
        data, _ = candles.window(snapshot, leaf, snapshot.cutoff_ms)
        expected, complete = volume.records(leaf, data, fetched_at_ms=snapshot.observed_ms)
        assert result[2:] == (expected, complete, None)
