"""REST-seeded, raw-tick volume detection and loss boundaries."""
import asyncio
import datetime as dt
from dataclasses import replace

import pytest
from pydantic import TypeAdapter

from hoga.api.events import EventBus
from hoga.api.models import ConditionLeaf
from hoga.api.screener_bar_volume import MinuteSnapshot, VolumeBar, records
from hoga.live import screener_volume as live
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind
from hoga.util.timeenc import KST

NOW = int(dt.datetime(2026, 10, 20, 12, 2, 1, tzinfo=KST).timestamp() * 1000)
START = NOW // 60_000 * 60_000


def condition(period=100, lookback=5, timeframe='1m', id='v'):
    return TypeAdapter(ConditionLeaf).validate_python(dict(id=id, type='new_high_vol',
        params=dict(timeframe=timeframe, period=period, lookback=lookback)))


def seed(runtime, leaf, code='005930', now=NOW, current=10):
    interval = int(leaf.params.timeframe[:-1]) * 60_000
    count = leaf.params.period + leaf.params.lookback - 1
    data = [VolumeBar(START - (count - i - 1) * interval, 1000) for i in range(count)]
    data[-1] = replace(data[-1], volume=current, is_open=True)
    runtime.seed(leaf, code, MinuteSnapshot(data, now), now)
    return data


def entry(cum, qty=1, stamp=NOW, venue='KRX'):
    return dict(kind='trade', t_ms=stamp, cum_volume=cum, venue=venue,
                trades=[dict(t_ms=stamp, qty=qty, price=100)])


async def test_crossing_is_pushed_before_bar_close_without_repeated_alerts_or_double_add():
    bus = EventBus()
    queue = bus.subscribe()
    runtime = live.ScreenerVolumeRuntime(bus.publish)
    leaf = condition()
    data = seed(runtime, leaf)
    runtime.ingest('005930', entry(10_000), NOW)
    runtime.ingest('005930', entry(11_000, qty=1000, stamp=NOW + 1), NOW + 1)
    runtime.ingest('005930', entry(11_000, qty=1000, stamp=NOW + 1), NOW + 1)
    event = await asyncio.wait_for(queue.get(), 1)
    assert event == dict(type='screener_volume_changed', condition_ids=['v'])
    snapshot, fetched, lower = runtime.snapshot(leaf, '005930', NOW + 1)
    assert snapshot[-1].volume == 1010  # REST baseline + delta; qty was not also added
    assert snapshot[-1].is_open and snapshot[-1].start_ms in lower
    events, complete = records(leaf, snapshot, fetched_at_ms=fetched)
    assert complete and events[-1].bar_start_ms == START
    # Reusing the same REST cache from another tab must not undo live progress.
    runtime.seed(leaf, '005930', MinuteSnapshot(data, NOW), NOW + 2)
    assert runtime.snapshot(leaf, '005930', NOW + 2)[0][-1].volume == 1010
    runtime.seed(leaf, '005930', MinuteSnapshot(data, NOW + 2), NOW + 2)
    assert runtime.snapshot(leaf, '005930', NOW + 2)[0][-1].volume == 1010
    assert queue.empty()
    runtime.close()


async def test_parent_buffer_delivery_and_ipc_gap_use_the_same_runtime():
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition()
    seed(runtime, leaf)
    buffer = LiveBuffer()
    release = buffer.observe_trades(runtime.ingest, runtime.gap)
    raw = entry(10_000)
    await buffer.publish('005930', [LiveSnapshot(NOW, SnapshotKind.TRADE, raw)], now_ms=NOW)
    assert runtime.counts([leaf], ['005930', '000660'], NOW) == (1, 1)
    assert runtime.counts([leaf, condition(timeframe='5m')], ['005930'], NOW) == (0, 0)
    await buffer.mark_delivery_gap({'005930'})
    assert runtime.snapshot(leaf, '005930', NOW) is None
    release()
    await buffer.publish('005930', [LiveSnapshot(NOW, SnapshotKind.TRADE, raw)], now_ms=NOW)
    assert runtime.counts([leaf], ['005930'], NOW) == (1, 0)
    runtime.close()


@pytest.mark.parametrize('bad', [
    entry(10_000, venue='NXT'), entry(10_000, venue='UN'),
    entry(10_000, stamp=NOW - 60_000), {**entry(10_000), 'cum_volume': None},
])
def test_other_venues_stale_ticks_and_missing_cumulative_volume_do_not_activate(bad):
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition()
    seed(runtime, leaf)
    runtime.ingest('005930', bad, NOW)
    assert runtime.counts([leaf], ['005930'], NOW) == (1, 0)


def test_first_tick_can_cross_but_partial_closed_bars_never_understate_the_peak():
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition(period=3, lookback=1)
    seed(runtime, leaf)
    runtime.ingest('005930', entry(10_000, qty=1500), NOW)
    assert runtime.snapshot(leaf, '005930', NOW)[0][-1].volume == 1500
    runtime.ingest('005930', entry(12_000, qty=2000, stamp=START + 60_000), START + 60_000)
    data = runtime.snapshot(leaf, '005930', START + 60_000)
    assert data is None  # REST seed expired; reconciliation is required
    watch = runtime._watches[runtime._key(leaf, '005930')]
    assert not watch.bars[-2].valid
    assert not records(leaf, watch.bars, fetched_at_ms=NOW)[0]
    runtime.close()


def test_cumulative_rewind_and_reconnect_do_not_add_a_whole_day_volume():
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition(period=3, lookback=1)
    seed(runtime, leaf)
    runtime.ingest('005930', entry(10_000), NOW)
    runtime.ingest('005930', entry(10_100, qty=100, stamp=NOW + 1), NOW + 1)
    runtime.ingest('005930', entry(500, qty=1, stamp=NOW + 2), NOW + 2)
    runtime.ingest('005930', entry(501, qty=1, stamp=NOW + 3), NOW + 3)
    assert runtime.snapshot(leaf, '005930', NOW + 3)[0][-1].volume == 111
    runtime.close()


def test_watch_expiry_budget_and_full_universe_denominator(monkeypatch):
    monkeypatch.setattr(live, 'MAX_WATCHES', 2)
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition()
    for code in ['000001', '000002', '000003']:
        seed(runtime, leaf, code)
    assert runtime.counts([leaf], ['000001', '000002', '000003'], NOW) == (2, 0)
    assert runtime.snapshot(leaf, '000001', NOW) is None
    assert runtime.snapshot(leaf, '000003', NOW + live.WATCH_TTL_MS + 1) is None
    runtime.close()


def test_missing_trades_across_a_short_bar_boundary_invalidate_both_bars():
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition(period=3, lookback=1)
    seed(runtime, leaf, now=START + 59_000)
    runtime.ingest('005930', entry(10_000, stamp=START + 59_000), START + 59_000)
    # A continuously observed next minute is initially an exact raw-WS bar.
    runtime.ingest('005930', entry(10_001, stamp=START + 60_000), START + 60_000)
    for second in [10, 20, 30, 40, 50, 59]:
        at = START + 60_000 + second * 1000
        runtime.ingest('005930', entry(10_001 + second, stamp=at), at)
    # Only one second elapsed, but cumulative volume includes unobserved trades.
    at = START + 120_000
    runtime.ingest('005930', entry(10_200, stamp=at), at)
    watch = runtime._watches[runtime._key(leaf, '005930')]
    assert not watch.bars[-2].valid
    assert watch.bars[-1].start_ms in watch.lower_bounds
    assert watch.bars[-1].volume == 1
    assert not records(leaf, watch.bars, fetched_at_ms=at)[0]
    runtime.close()


def test_closing_auction_bar_is_complete_when_the_trade_arrives():
    runtime = live.ScreenerVolumeRuntime()
    leaf = condition(period=3, lookback=1)
    close = int(dt.datetime(2026, 10, 20, 15, 30, tzinfo=KST).timestamp() * 1000)
    data = [VolumeBar(close - 120_000, 500), VolumeBar(close - 60_000, 1000), VolumeBar(close, 0)]
    runtime.seed(leaf, '005930', MinuteSnapshot(data, close), close)
    runtime.ingest('005930', entry(10_000, qty=2000, stamp=close), close)
    snapshot = runtime.snapshot(leaf, '005930', close)[0]
    assert snapshot[-1].volume == 2000 and not snapshot[-1].is_open
    assert records(leaf, snapshot, fetched_at_ms=close)[0]
    runtime.close()
