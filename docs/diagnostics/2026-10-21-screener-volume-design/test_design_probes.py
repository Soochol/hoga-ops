"""Design experiments only; not a new production runtime or a release gate.

Current limitations are characterized deliberately. Candidate protocol algebra
checks assumptions, not an implemented integration or provider ground truth.
No network, servers, credentials, saved settings or broker subscriptions.
"""
from __future__ import annotations

import random
from dataclasses import replace
from datetime import datetime

import pytest
from pydantic import TypeAdapter

from hoga.api.models import ConditionLeaf
from hoga.api.screener_bar_volume import MinuteSnapshot, VolumeBar, records
from hoga.live.collector_ipc import BoundedOutbox, PeakSnapshotDelta, encode
from hoga.live.minute_candle_agg import MinuteCandleAggregator
from hoga.live.screener_volume import ScreenerVolumeRuntime
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick
from hoga.util.timeenc import KST

START = int(datetime(2026, 10, 21, 10, 0, tzinfo=KST).timestamp() * 1000)
NOW = START + 1000


def leaf(period=100, lookback=5):
    return TypeAdapter(ConditionLeaf).validate_python(dict(id=f'v-{period}-{lookback}', type='new_high_vol',
        params=dict(period=period, lookback=lookback, timeframe='1m', include_open_bar=True)))


def seed(runtime, condition, code='005930'):
    count = condition.params.period + condition.params.lookback - 1
    bars = [VolumeBar(START - (count - i - 1) * 60_000, 1000) for i in range(count)]
    bars[-1] = replace(bars[-1], volume=10, is_open=True)
    runtime.seed(condition, code, MinuteSnapshot(bars, NOW), NOW)


def raw(qty, cumulative, stamp=NOW, code='005930', venue='KRX'):
    payload = dict(cum_volume=cumulative, trades=[dict(t_ms=stamp, qty=qty, price=100)])
    return WsTick(code, stamp, SnapshotKind.TRADE, payload, venue)


def test_current_runtime_rejects_old_seed_even_with_fresh_continuous_ticks():
    runtime = ScreenerVolumeRuntime()
    condition = leaf()
    seed(runtime, condition)
    for seconds in range(1, 22):
        stamp = START + seconds * 1000
        tick = raw(1, 1000 + seconds, stamp)
        runtime.ingest(tick.code, dict(kind='trade', venue='KRX', t_ms=stamp, **tick.payload), stamp)
    assert runtime.counts([condition], ['005930'], START + 21_000) == (1, 1)
    assert runtime.snapshot(condition, '005930', START + 21_000) is None
    runtime.close()


def test_current_two_conditions_evict_active_watches_for_338_symbols():
    runtime = ScreenerVolumeRuntime()
    codes = [f'{i:06d}' for i in range(338)]
    first, second = leaf(), leaf(period=101)
    for condition in [first, second]:
        for code in codes:
            seed(runtime, condition, code)
    expected_first = 512 - len(codes)
    assert runtime.counts([first], codes, NOW)[0] == expected_first
    assert runtime.counts([second], codes, NOW)[0] == len(codes)
    runtime.close()


def test_rest_baseline_and_ws_overlap_can_overcount_but_max_is_a_lower_bound():
    rng = random.Random(20261021)
    for _ in range(2000):
        quantities = [rng.randrange(1, 500) for _ in range(20)]
        rest_cut = rng.randrange(1, 20)
        ws_cut = rng.randrange(0, rest_cut)
        rest = sum(quantities[:rest_cut])
        ws = sum(quantities[ws_cut:])
        truth = sum(quantities)
        assert rest + ws > truth  # overlap is counted twice
        assert max(rest, ws) <= truth


def test_raw_aggregator_matches_complete_observed_minutes_for_338_symbols():
    rng = random.Random(338)
    aggregator = MinuteCandleAggregator()
    expected = {}
    for i in range(338):
        code = f'{i:06d}'
        cumulative = 100_000
        quantities = [rng.randrange(1, 1000) for _ in range(30)]
        expected[code] = sum(quantities)
        for j, qty in enumerate(quantities):
            cumulative += qty
            aggregator.ingest(raw(qty, cumulative, START + j * 1000, code))
    closed = aggregator.flush(now_ms=START + 60_000)
    assert {code: snaps[0].payload['volume'] for (code, venue), snaps in closed.items()} == expected


def test_existing_raw_aggregator_cannot_prove_a_midminute_seed_is_complete():
    aggregator = MinuteCandleAggregator()
    # Actual minute had an earlier, unobserved 100 shares.
    aggregator.ingest(raw(5, 10_105, START + 20_000))
    aggregator.ingest(raw(8, 10_113, START + 30_000))
    bar = aggregator.flush(now_ms=START + 60_000)[('005930', 'KRX')][0]
    observed, actual = 13, 113
    assert bar.payload['volume'] == observed
    assert bar.payload['volume'] < actual
    assert not {'complete', 'epoch', 'coverage_start_ms'}.intersection(bar.payload)


def test_display_outbox_can_drop_trade_frames():
    outbox = BoundedOutbox(max_messages=1, max_bytes=4096)
    outbox.put(encode(dict(sequence=1, volume_delta=30)))
    newest = encode(dict(sequence=2, volume_delta=70))
    outbox.put(newest)
    assert outbox.dropped == 1
    assert list(outbox.frames) == [newest]


def test_existing_cumulative_state_protocol_replaces_queued_delta_with_full_state():
    delta = PeakSnapshotDelta()
    initial = dict(desired_version=1, peaks={'005930': {'volume': 30}})
    assert delta.apply(initial, queued=False)['peaks_full']
    newest = dict(desired_version=1, peaks={'005930': {'volume': 100}})
    recovered = delta.apply(newest, queued=True)
    assert recovered['peaks_full']
    assert recovered['peaks'] == newest['peaks']


@pytest.mark.parametrize('order', [(1, 2, 3), (3, 2, 1), (2, 2, 1, 3), (3,), (1, 3, 2, 3)])
def test_candidate_absolute_bar_revisions_converge_after_lost_duplicate_or_reordered_frames(order):
    # Algebraic candidate only: monotonically versioned absolute bar state,
    # not cumulative deltas. Payload/epoch/quality validation still required.
    states = {1: (30, False), 2: (100, False), 3: (80, True)}
    applied, volume, complete = 0, None, False
    for revision in order:
        if revision > applied:
            applied = revision
            volume, complete = states[revision]
    assert (applied, volume, complete) == (3, 80, True)
    # Authority can correct downward; using max forever would preserve 100.


def test_completed_rest_bar_must_not_be_max_merged_with_stale_live_bar():
    stale_live, authoritative_rest = 1200, 900
    threshold = 1000
    assert max(stale_live, authoritative_rest) >= threshold
    assert authoritative_rest < threshold


def test_vendor_bar_count_cannot_be_replaced_by_elapsed_clock_minutes():
    aggregator = MinuteCandleAggregator()
    aggregator.ingest(raw(10, 1000, START))
    aggregator.ingest(raw(20, 1020, START + 180_000))
    bars = aggregator.flush(now_ms=START + 240_000)[('005930', 'KRX')]
    assert [bar.t_ms for bar in bars] == [START, START + 180_000]
    expected_bars = 2
    assert len(bars) == expected_bars  # no fabricated zero-volume bars in the gap


def test_quality_requires_clean_comparisons_even_when_current_lower_bound_crosses():
    condition = leaf(period=3, lookback=1)
    data = [VolumeBar(START - 120_000, 10), VolumeBar(START - 60_000, 20),
            VolumeBar(START, 30, is_open=True)]
    assert records(condition, data, fetched_at_ms=NOW)[0]
    broken = [data[0], replace(data[1], valid=False), data[2]]
    assert not records(condition, broken, fetched_at_ms=NOW)[0]


def test_candidate_data_shape_shares_history_and_stays_within_bar_budget():
    codes = 338
    period, lookback = 100, 5
    shared_history = codes * (period + lookback - 1)
    expected, budget = 35_152, 250_000
    assert shared_history == expected
    assert shared_history < budget
    # Many conditions can share one stream, but large windows need admission.
    assert codes * (1000 + 250 - 1) > budget


def test_candidate_protocol_rejects_old_connection_and_configuration_generations():
    current_epoch, current_config = 'new-epoch', 2
    frames = [
        dict(epoch='old-epoch', config=2, revision=999, volume=9999),
        dict(epoch='new-epoch', config=1, revision=999, volume=9999),
        dict(epoch='new-epoch', config=2, revision=1, volume=50),
        dict(epoch='old-epoch', config=2, revision=1000, volume=9999),
    ]
    revision, actual = 0, None
    for frame in frames:
        if (frame['epoch'], frame['config']) != (current_epoch, current_config):
            continue
        if frame['revision'] > revision:
            revision, actual = frame['revision'], frame['volume']
    expected = 50
    assert actual == expected


def test_existing_aggregator_rewind_fallback_is_not_a_quality_certificate():
    aggregator = MinuteCandleAggregator()
    aggregator.ingest(raw(5, 1005, START + 1000))
    aggregator.ingest(raw(10, 10, START + 2000))
    bar = aggregator.flush(now_ms=START + 60_000)[('005930', 'KRX')][0]
    observed_sum = 15
    assert bar.payload['volume'] == observed_sum
    assert 'complete' not in bar.payload
