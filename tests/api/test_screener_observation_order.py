import datetime as dt
from types import SimpleNamespace

import pytest

from hoga.api import screener_bar_volume as volume
from hoga.api.models import ScanRequest
from hoga.api.screener_continuous import ContinuousMonitors, History, Monitor
from hoga.live.volume_state import VolumeReplica, VolumeSource
from hoga.util.timeenc import KST

START = int(dt.datetime(2026, 10, 21, 12, tzinfo=KST).timestamp() * 1000)
CODE = '005930'


def trade(stamp, cumulative, price, qty):
    return dict(kind='trade', t_ms=stamp, cum_volume=cumulative,
                trades=[dict(t_ms=stamp, price=price, qty=qty)])


async def delayed_history(tmp_path, monkeypatch, rest_volume, rest_close, ws_volume, ws_close):
    clock = SimpleNamespace(now=START + 20_000)
    source = VolumeSource('ordered')
    source.configure({CODE})
    source.health({CODE: 'account:1'}, START - 60_000)
    source.ingest(CODE, trade(START - 1000, 1000, 100, 1), START - 1000)
    source.ingest(CODE, trade(START + 1000, 1010, 100, 10), START + 1000)
    replica = VolumeReplica()
    replica.reset('ordered')

    async def targets(_codes):
        for frame in source.frames(clock.now):
            replica.apply(frame, clock.now)

    owner = ContinuousMonitors(tmp_path, None, SimpleNamespace(volume_replica=replica), targets,
                               now=lambda: clock.now)
    history = History(needed=1, bars=[volume.VolumeBar(START, 10, True, True, 100, 100, 100, 100)],
                      fetched_ms=START + 10_000, coverage_start_ms=START)
    owner.histories[CODE] = history
    await targets([CODE])
    owner.merge(CODE, history, clock.now)
    loaded = []

    async def capacity(*_args, **_kwargs):
        stamp = START + 21_000
        source.ingest(CODE, trade(stamp, 1000 + ws_volume, ws_close, ws_volume - 10), stamp)
        clock.now = max(clock.now, START + 30_000)
        await targets([CODE])
        owner.merge(CODE, history, clock.now)
        return SimpleNamespace(rows=[dict(cntr_tm='20261021120000', open_pric='100',
            high_pric=str(rest_close), low_pric='100', cur_prc=str(rest_close), trde_qty=str(rest_volume))])

    async def loader(data_dir, code, timeframe, needed, lower, as_of):
        result = await volume._fetch_minutes(data_dir, code, timeframe, needed, lower, as_of)
        loaded.append(result)
        return result

    owner.loader = loader
    monkeypatch.setattr(volume.time, 'time', lambda: clock.now / 1000)
    monkeypatch.setattr(volume.kiwoom_rest_runtime, 'ensure_rest_client', lambda _dir: object())
    monkeypatch.setattr(volume.kiwoom_rest_runtime, 'ensure_scheduler', lambda _dir: None)
    monkeypatch.setattr(volume.kiwoom_access, 'run_with_capacity', capacity)
    await owner.prepare(CODE, history)
    return SimpleNamespace(owner=owner, history=history, clock=clock, targets=targets, loaded=loaded)


@pytest.mark.parametrize('rest_volume,rest_close,ws_volume,ws_close,expected_close', [
    (20, 110, 15, 105, 110),
    (15, 105, 20, 110, 110),
    (20, 110, 20, 110, 110),
    (20, 110, 20, 105, None),
    (20, 102, 15, 105, None),
])
async def test_delayed_full_rest_fetch_orders_whole_open_ohlcv_and_replay(
        tmp_path, monkeypatch, rest_volume, rest_close, ws_volume, ws_close, expected_close):
    setup = await delayed_history(tmp_path, monkeypatch, rest_volume, rest_close, ws_volume, ws_close)
    owner, history, clock, targets, loaded = setup.owner, setup.history, setup.clock, setup.targets, setup.loaded
    if expected_close is None:
        snapshot = owner.snapshot(CODE, clock.now)
        assert history.repair_until_ms
        assert not snapshot.bars[-1].valid
        request = ScanRequest.model_validate(dict(conditions=[dict(id='price', type='change_pct',
            params=dict(timeframe='1m', change_reference='bar_open', op='gte', pct=8))]))
        owner.monitors['test'] = Monitor('test', 'client', request, [CODE], request.conditions, clock.now)
        clock.now = history.retry_at
        owner.schedule({CODE}, clock.now)
        assert set(owner.pending) == {CODE}
        import asyncio
        await asyncio.gather(*owner.pending.values())
        assert history.repair_until_ms
        return
    expected = volume.VolumeBar(START, max(rest_volume, ws_volume), True, True,
                               100, expected_close, 100, expected_close)
    assert history.bars[-1] == expected
    leaf = ScanRequest.model_validate(dict(conditions=[dict(id='price', type='change_pct',
        params=dict(timeframe='1m', change_reference='bar_open', op='gte', pct=8))])).conditions[0]
    events, complete = volume.records(leaf, history.bars, fetched_at_ms=history.fetched_ms)
    assert (bool(events), complete) == (True, True)
    clock.now += 1000
    await targets([CODE])
    owner.merge(CODE, history, clock.now)
    assert history.bars[-1] == expected
    assert loaded[0].fetched_at_ms == START + 20_000
    assert loaded[0].response_received_ms == START + 30_000
    snapshot = owner.snapshot(CODE, clock.now)
    expected_observation = START + (30_000 if rest_volume > ws_volume else 21_000)
    assert snapshot.observed_ms == expected_observation
    clock.now = START + 60_000
    await targets([CODE])
    closed = owner.snapshot(CODE, clock.now)
    assert closed.bars[-1].volume == max(rest_volume, ws_volume)
    assert closed.bars[-1].close == expected_close
    assert closed.bars[-1].valid == (ws_volume >= rest_volume)
    assert closed.observed_ms == expected_observation


def test_minute_bar_order_never_pairs_a_volume_with_another_observations_price():
    from hoga.api.screener_continuous_bars import ordered_minute_bar

    old = volume.VolumeBar(START, 20, True, True, 100, 110, 95, 105)
    for newer in [volume.VolumeBar(START, 25, True, True, 101, 115, 95, 112),
                  volume.VolumeBar(START, 25, True, True, 100, 109, 95, 108),
                  volume.VolumeBar(START, 25, True, True, 100, 115, 96, 112)]:
        for first, second in [(old, newer), (newer, old)]:
            selected = ordered_minute_bar(first, second)
            assert not selected.valid
            assert selected.volume == 25
            assert selected.open is selected.high is selected.low is selected.close is None


def test_accepted_observations_are_bounded_and_reset_with_the_trading_day():
    from hoga.api import screener_continuous_bars as candles

    data = [volume.VolumeBar(START + i * 60_000, i) for i in range(10)]
    history = History(needed=2, bars=data, observation_ms={bar.start_ms: bar.start_ms for bar in data})
    candles.reconcile_rest(history, {}, START)
    assert len(history.bars) == len(history.observation_ms) == 3
    candles.reset_day(history, START + 24 * 60 * 60_000)
    assert not history.observation_ms


async def test_cancelled_delayed_rest_does_not_publish_response_observations(tmp_path):
    import asyncio

    began, release = asyncio.Event(), asyncio.Event()
    replica = VolumeReplica()
    async def targets(_codes):
        pass
    async def loader(*_args):
        began.set()
        await release.wait()
        return volume.MinuteSnapshot([], START, response_received_ms=START + 30_000)
    owner = ContinuousMonitors(tmp_path, None, SimpleNamespace(volume_replica=replica), targets,
                               loader=loader, now=lambda: START + 20_000)
    history = History(needed=1, fetched_ms=START, observation_ms={START: START})
    task = asyncio.create_task(owner.prepare(CODE, history))
    await began.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert history.fetched_ms == START
    assert history.observation_ms == {START: START}
