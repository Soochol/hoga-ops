"""One result's immutable minute aggregates, including coverage and readiness."""
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

