import asyncio
import datetime as dt
import json
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from pydantic import TypeAdapter

from hoga.api import screener_bar_volume as bars
from hoga.api.models import ConditionLeaf, ScanRequest
from hoga.api.screener_continuous import ContinuousAdapter, ContinuousMonitors, History
from hoga.live.buffer import LiveBuffer
from hoga.live.volume_state import PROTOCOL, REPLAY_MS
from hoga.util.timeenc import KST

START = int(dt.datetime(2026, 10, 21, 10, 0, tzinfo=KST).timestamp() * 1000)


def request(period=100, scopes=None):
    return ScanRequest.model_validate(dict(conditions=[dict(id='v', type='new_high_vol',
        params=dict(timeframe='1m', period=period, lookback=5))],
        universe=dict(scopes=['watchlist', 'heatmap'] if scopes is None else scopes), basis='intraday'))


@pytest.fixture
async def fixture(tmp_path):
    clock = SimpleNamespace(now=START + 20_000)
    calls = []
    buffer = LiveBuffer()

    async def targets(codes):
        buffer.volume_source.configure(codes)
        buffer.volume_source.health(dict.fromkeys(codes, 'a:1'), clock.now)
        for frame in buffer.volume_source.frames(clock.now):
            buffer.volume_replica.apply(frame, clock.now)

    async def loader(data_dir, code, timeframe, needed, lower, as_of):
        calls.append((code, needed))
        values = [bars.VolumeBar(START - (needed - i - 1) * 60_000, 1000) for i in range(needed)]
        values[-1] = replace(values[-1], volume=10, is_open=True)
        return bars.MinuteSnapshot(values, clock.now)

    owner = ContinuousMonitors(tmp_path, None, buffer, targets, loader=loader, now=lambda: clock.now)

    async def resolve(req):
        return ['005930', '000660']

    owner.resolve = resolve
    yield owner, clock, calls
    await owner.close()


async def start(owner, req=None, client='test'):
    status = await owner.start(client, req or request())
    owner.loop_task.cancel()
    await asyncio.gather(owner.loop_task, return_exceptions=True)
    owner.loop_task = None
    return owner.get(status.id)


async def test_prepare_and_healthy_idle_history_survive_15_seconds_without_repeated_rest(fixture):
    owner, clock, calls = fixture
    monitor = await start(owner)
    await owner.set_targets(set(monitor.codes))
    for code in monitor.codes:
        await owner.prepare(code, owner.histories[code])
    assert len(calls) == 2
    clock.now += 30_000
    await owner.set_targets(set(monitor.codes))
    for code in monitor.codes:
        owner.merge(code, owner.histories[code], clock.now)
    adapter = ContinuousAdapter(owner, monitor)
    selected = monitor.leaves[0]
    assert len(adapter.snapshot(selected, '005930', clock.now)[0]) >= 104
    assert adapter.counts(monitor.leaves, monitor.codes, clock.now) == (2, 2)
    owner.schedule(set(monitor.codes), clock.now)
    assert not owner.pending
    assert len(calls) == 2


async def test_query_while_preparing_does_not_fetch_on_the_result_path(fixture, monkeypatch):
    owner, clock, calls = fixture
    monitor = await start(owner)
    monkeypatch.setattr(bars.time, 'time', lambda: clock.now / 1000)
    result = await bars.evaluate(data_dir=owner.data_dir, conditions=monitor.request.conditions,
        codes=monitor.codes, basis='intraday', now=dt.datetime.fromtimestamp(clock.now / 1000, KST),
        volume_runtime=ContinuousAdapter(owner, monitor))
    assert calls == []
    assert result.coverage.realtime.continuous
    assert result.coverage.realtime.preparing == 2
    assert result.coverage.complete == 0


async def test_multiple_conditions_share_history_and_capacity_rejection_preserves_existing(fixture):
    owner, _, calls = fixture
    first = await start(owner)
    second = await start(owner, request(period=101), client='second')
    assert first.id != second.id
    assert len(owner.histories) == 2
    for code in second.codes:
        await owner.prepare(code, owner.histories[code])
    assert len(calls) == 2
    assert all(history.needed == 105 for history in owner.histories.values())
    with pytest.raises(HTTPException, match='409'):
        await owner.start('oversized', request(period=100_000))
    assert len(owner.monitors) == 2


async def test_no_scope_is_rejected_without_creating_any_monitor(fixture):
    owner, _, _ = fixture
    with pytest.raises(HTTPException, match='422'):
        await owner.start('bad', request(scopes=[]))
    assert not owner.monitors


async def test_authoritative_closed_bar_correction_can_reduce_volume(fixture):
    owner, clock, _ = fixture
    monitor = await start(owner)
    history = owner.histories['005930']
    await owner.prepare('005930', history)
    history.bars[-2] = replace(history.bars[-2], volume=9999)
    await owner.prepare('005930', history)
    assert history.bars[-2].volume == 1000
    # Late collector replay cannot undo the completed REST correction.
    owner.replica.reset('epoch')
    owner.replica.apply(dict(protocol=PROTOCOL, epoch='epoch', observed_ms=clock.now, streams={'005930':dict(
        revision=1, generation='a:1', ready=True, tick_ms=clock.now, since_ms=START,
        replay_since_ms=clock.now - REPLAY_MS,
        bars=[[START - 60_000, 9999, True, None, None, None, None, False,
               START - 60_000, START - 60_000]])}), clock.now)
    owner.merge('005930', history, clock.now)
    assert history.bars[-2].volume == 1000
    assert monitor.id in owner.monitors


async def test_partial_open_bar_rest_overlap_is_not_added_and_postresponse_delta_is_safe(fixture):
    owner, clock, _ = fixture
    await start(owner)
    history = owner.histories['005930']
    await owner.prepare('005930', history)
    owner.replica.reset('epoch')

    def state(observed_ms, volume, revision):
        return dict(protocol=PROTOCOL, epoch='epoch', observed_ms=observed_ms, streams={'005930':dict(
            revision=revision, generation='a:1', ready=True, tick_ms=observed_ms, since_ms=START + 1000,
            replay_since_ms=observed_ms - REPLAY_MS,
            bars=[[START, volume, False, None, None, None, None, False, START, START]])})

    owner.replica.apply(state(clock.now - 1, 8, 1), clock.now)
    owner.merge('005930', history, clock.now)
    assert history.bars[-1].volume == 10  # REST 10 and observed 8 overlap.
    clock.now += 1000
    owner.replica.apply(state(clock.now, 12, 2), clock.now)
    owner.merge('005930', history, clock.now)
    assert history.bars[-1].volume == 12  # first post-response anchor, not 14
    clock.now += 1000
    owner.replica.apply(state(clock.now, 15, 3), clock.now)
    owner.merge('005930', history, clock.now)
    assert history.bars[-1].volume == 15
    clock.now = START + 60_000
    owner.replica.apply(state(clock.now, 15, 3), clock.now)
    owner.merge('005930', history, clock.now)
    assert not history.bars[-1].valid


async def test_stop_lease_and_reuse_do_not_clear_other_monitor_history(fixture):
    owner, clock, calls = fixture
    first = await start(owner)
    second = await start(owner, client='second')
    await owner.prepare('005930', owner.histories['005930'])
    owner.stop(first.id)
    clock.now += 1000
    assert owner.collect_active(clock.now) == set(second.codes)
    assert owner.histories['005930'].fetched_ms
    second.touched_ms = clock.now
    owner.stop(second.id)
    assert owner.collect_active(clock.now) == set()
    again = await start(owner, client='third')
    assert owner.histories['005930'].fetched_ms
    assert len(calls) == 1
    clock.now += 301_000
    assert owner.collect_active(clock.now) == set()
    assert again.id not in owner.monitors
    assert not owner.histories


def test_match_fingerprint_only_changes_on_crossing_or_quality_not_every_tick():
    condition = TypeAdapter(ConditionLeaf).validate_python(dict(id='v', type='new_high_vol_today',
        params=dict(timeframe='1m', period=3)))
    monitor = SimpleNamespace(leaves=[condition])
    history = History(3, bars=[bars.VolumeBar(START - 120_000, 50), bars.VolumeBar(START - 60_000, 100),
                             bars.VolumeBar(START, 10, True)])
    first = ContinuousMonitors.match_fingerprint(monitor, history)
    history.bars[-1] = replace(history.bars[-1], volume=20)
    assert ContinuousMonitors.match_fingerprint(monitor, history) == first
    history.bars[-1] = replace(history.bars[-1], volume=100)
    assert ContinuousMonitors.match_fingerprint(monitor, history) != first


async def test_insufficient_history_is_reported_and_not_retried_on_every_tick(fixture):
    owner, clock, calls = fixture
    monitor = await start(owner)

    async def short(*args):
        calls.append('short')
        return bars.MinuteSnapshot([bars.VolumeBar(START - 60_000, 10)], clock.now)

    owner.loader = short
    await owner.prepare('005930', owner.histories['005930'])
    status = owner.status(monitor, clock.now)
    assert status.insufficient == 1
    assert status.preparing == 1
    owner.schedule({'005930'}, clock.now + 15_000)
    assert not owner.pending
    assert calls == ['short']
    history = owner.histories['005930']
    history.bars = [bars.VolumeBar(START - i * 60_000, 10) for i in range(history.needed)]
    # A quiet/new listing can gain enough observed bars before its next audit.
    assert ContinuousAdapter(owner, monitor).reason('005930') is None
    assert owner.status(monitor, clock.now).insufficient == 0


async def test_http_monitor_contract_start_heartbeat_result_and_stop(fixture, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_continuous import build_router

    owner, clock, _ = fixture
    seen = []

    async def scan(**kwargs):
        seen.append(kwargs)
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    app = FastAPI()
    app.include_router(build_router(owner))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/monitors',
            json=dict(client_id='http', request=request().model_dump(mode='json')))
        assert response.status_code == 200
        body = response.json()
        assert set(body) == {'id', 'total', 'prepared', 'receiving', 'preparing', 'recovering', 'unavailable',
                             'insufficient', 'last_verified_ms', 'error'}
        monitor_id = body['id']
        response = await client.post(f'/monitors/{monitor_id}/heartbeat')
        assert response.status_code == 200
        response = await client.get(f'/monitors/{monitor_id}/result')
        assert response.json()['status'] == 'ok'
        assert seen[0]['req'].basis == 'intraday'
        assert isinstance(seen[0]['volume_runtime'], ContinuousAdapter)
        response = await client.delete(f'/monitors/{monitor_id}')
        assert response.status_code == 204
        assert (await client.get(f'/monitors/{monitor_id}/result')).status_code == 404
    assert clock.now > 0


@pytest.mark.parametrize('retire', ['delete', 'replace', 'expire', 'close'])
async def test_result_retirement_cancels_scan_before_later_minute_work(fixture, monkeypatch, retire):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_continuous import build_router

    owner, clock, _ = fixture
    monitor = await start(owner)
    entered, release, cancelled = asyncio.Event(), asyncio.Event(), asyncio.Event()
    later = []

    async def scan(**kwargs):
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise
        later.append('minute')
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    app = FastAPI()
    app.include_router(build_router(owner))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        reader = asyncio.create_task(client.get(f'/monitors/{monitor.id}/result'))
        await entered.wait()
        if retire == 'delete':
            assert (await client.delete(f'/monitors/{monitor.id}')).status_code == 204
        elif retire == 'replace':
            await start(owner, request(period=101))
        elif retire == 'expire':
            clock.now += 301_000
            owner.collect_active(clock.now)
        else:
            await owner.close()
        for _ in range(10):
            await asyncio.sleep(0)
        was_cancelled = cancelled.is_set()
        release.set()
        response = await reader
        assert (was_cancelled, response.status_code, later) == (True, 404, [])


async def test_overlapping_result_readers_share_work_and_cancel_independently(fixture, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_continuous import build_router

    owner, _, _ = fixture
    monitor = await start(owner)
    release, entered = asyncio.Event(), asyncio.Event()
    calls, cancelled = [], []

    async def scan(**kwargs):
        calls.append(kwargs)
        entered.set()
        try:
            await release.wait()
        except asyncio.CancelledError:
            cancelled.append(True)
            raise
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    app = FastAPI()
    app.include_router(build_router(owner))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        first = asyncio.create_task(client.get(f'/monitors/{monitor.id}/result'))
        await entered.wait()
        second = asyncio.create_task(client.get(f'/monitors/{monitor.id}/result'))
        for _ in range(10):
            await asyncio.sleep(0)
        entries = len(calls)
        first.cancel()
        await asyncio.gather(first, return_exceptions=True)
        release.set()
        assert (await second).status_code == 200
        assert (entries, cancelled) == (1, [])
        assert (await client.get(f'/monitors/{monitor.id}/result')).status_code == 200
        assert len(calls) == 2


async def test_new_result_reader_waits_for_cancelled_flight_to_finish(fixture, monkeypatch):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_continuous import build_router

    owner, _, _ = fixture
    monitor = await start(owner)
    entered, retired = asyncio.Event(), asyncio.Event()
    calls = []

    async def scan(**kwargs):
        calls.append(kwargs)
        if len(calls) == 1:
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await retired.wait()
                raise
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    app = FastAPI()
    app.include_router(build_router(owner))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        first = asyncio.create_task(client.get(f'/monitors/{monitor.id}/result'))
        await entered.wait()
        first.cancel()
        for _ in range(10):
            await asyncio.sleep(0)
        second = asyncio.create_task(client.get(f'/monitors/{monitor.id}/result'))
        for _ in range(10):
            await asyncio.sleep(0)
        before_retirement = first.done(), len(calls)
        retired.set()
        await asyncio.gather(first, return_exceptions=True)
        assert (await second).status_code == 200
        assert before_retirement == (True, 1)
        assert len(calls) == 2


async def test_retiring_result_tasks_count_toward_admission(fixture, monkeypatch):
    from hoga.api import screener_continuous, screener_runner
    from hoga.api.models import ScreenerResponse

    owner, _, _ = fixture
    monitor = await start(owner)
    entered, retired = asyncio.Event(), asyncio.Event()

    async def scan(**kwargs):
        if kwargs['volume_runtime'].monitor is monitor:
            entered.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await retired.wait()
                raise
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    monkeypatch.setattr(screener_continuous, 'MAX_MONITORS', 1)
    reader = asyncio.create_task(owner.result(monitor.id))
    await entered.wait()
    owner.stop(monitor.id)
    replacement = await start(owner)
    with pytest.raises(HTTPException, match='409'):
        await owner.result(replacement.id)
    retired.set()
    outcome = await asyncio.gather(reader, return_exceptions=True)
    assert isinstance(outcome[0], HTTPException)
    assert outcome[0].status_code == 404
    assert (await owner.result(replacement.id)).status == 'ok'


async def test_shared_result_readers_receive_independent_models_and_later_requests_retry(fixture, monkeypatch):
    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse

    owner, _, _ = fixture
    monitor = await start(owner)
    entered, release = asyncio.Event(), asyncio.Event()
    original = ScreenerResponse(status='ok', rows=[])
    calls = []

    async def scan(**kwargs):
        calls.append(kwargs)
        entered.set()
        await release.wait()
        if len(calls) == 2:
            raise ValueError('provider failed')
        return original

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    first = asyncio.create_task(owner.result(monitor.id))
    await entered.wait()
    second = asyncio.create_task(owner.result(monitor.id))
    await asyncio.sleep(0)
    release.set()
    a, b = await asyncio.gather(first, second)
    a.warnings.append('changed by reader')
    assert b.warnings == original.warnings == []
    with pytest.raises(ValueError, match='provider failed'):
        await owner.result(monitor.id)
    assert (await owner.result(monitor.id)).status == 'ok'
    assert len(calls) == 3


async def test_result_phase_logs_keep_each_monitor_and_scan_correlated(fixture, monkeypatch, caplog):
    import logging

    from hoga.api import screener_runner
    from hoga.api.models import ScreenerResponse
    from hoga.api.screener_timing import phase

    owner, _, _ = fixture
    first, second = await start(owner), await start(owner, client='second')

    async def scan(**kwargs):
        with phase('overlay'):
            await asyncio.sleep(0)
        return ScreenerResponse(status='ok', rows=[])

    monkeypatch.setattr(screener_runner, 'run_screener_scan', scan)
    caplog.set_level(logging.DEBUG, logger='hoga.api.screener_timing')
    await asyncio.gather(owner.result(first.id), owner.result(second.id))
    messages = [record.getMessage() for record in caplog.records if record.name == 'hoga.api.screener_timing']
    assert len(messages) == 4
    scan_ids = set()
    for monitor in [first, second]:
        matching = [message for message in messages if f'monitor_id={monitor.id} ' in message]
        assert len(matching) == 2
        fields = [dict(field.split('=', 1) for field in message.split()[1:]) for message in matching]
        assert {field['phase'] for field in fields} == {'overlay', 'total'}
        assert len({field['scan_id'] for field in fields}) == 1
        scan_ids.add(fields[0]['scan_id'])
    assert len(scan_ids) == 2
    with phase('standalone'):
        pass
    assert len(caplog.records) == 4


async def test_full_regular_session_338_symbols_shared_conditions_and_targeted_repair(fixture, tmp_path):
    from hoga.live.volume_state import MINUTE, VolumeSource
    from hoga.util.retained_size import retained_size

    owner, clock, _ = fixture
    base = START - 60 * MINUTE
    codes = [f'{i:06d}' for i in range(338)]
    oracle = {code: [] for code in codes}  # Same-day policy: no prior-session seed.
    clock.now = base
    calls = []

    async def resolve(_req):
        return codes

    async def loader(_dir, code, _tf, needed, _lower, _asof):
        calls.append(code)
        data = [bars.VolumeBar(stamp, qty, stamp + MINUTE > clock.now) for stamp, qty in oracle[code][-needed:]]
        return bars.MinuteSnapshot(data, clock.now)

    owner.resolve, owner.loader = resolve, loader
    first = await start(owner)
    second = await start(owner, request(period=101), client='second')
    source = VolumeSource('replay')
    source.configure(codes)
    source.health(dict.fromkeys(codes, 'a:1'), base)
    owner.replica.reset('replay')
    for code in codes:
        await owner.prepare(code, owner.histories[code])
    adapters = [ContinuousAdapter(owner, monitor) for monitor in [first, second]]
    cumulative = dict.fromkeys(codes, 1_000_000)
    checks = 0
    began = time.perf_counter()
    rss_before = int(Path('/proc/self/statm').read_text().split()[1]) * 4096
    for minute in range(390):
        clock.now = base + minute * MINUTE + 1000
        if minute in {120, 121}:
            generations = dict.fromkeys(codes, 'a:1')
            if minute == 120:
                generations.pop(codes[0])
            source.health(generations, clock.now - 1000)
        for index, code in enumerate(codes):
            qty = (index + minute) % 50 + 1
            cumulative[code] += qty
            source.ingest(code, dict(kind='trade', venue='KRX', t_ms=clock.now,
                cum_volume=cumulative[code], trades=[dict(t_ms=clock.now, qty=qty)]), clock.now)
            oracle[code].append((clock.now // MINUTE * MINUTE, qty))
        for frame in source.frames(clock.now):
            owner.replica.apply(frame, clock.now)
        if minute == 122:
            await owner.prepare(codes[0], owner.histories[codes[0]])
        checks += check_replay(owner, codes, oracle, adapters, [first, second], minute, clock.now)
    assert len(owner.histories) == len(codes)
    assert len(calls) == len(codes) + 1  # one preparation per shared stream, one damaged stream repaired
    assert all(len(history.bars) <= history.needed + 1 for history in owner.histories.values())
    retained = retained_size(owner.histories, limit=64*1024*1024, max_nodes=1_000_000)
    assert retained <= 64*1024*1024
    rss_after = int(Path('/proc/self/statm').read_text().split()[1]) * 4096
    summary = dict(symbols=len(codes), conditions=2, market_minutes=390, checked_evaluations=checks,
        history_calls=len(calls), retained_history_bytes=retained, rss_delta_bytes=rss_after-rss_before,
        seconds=round(time.perf_counter()-began, 3))
    (tmp_path/'replay.json').write_text(json.dumps(summary))
    print('CONTINUOUS_REPLAY_RESULT ' + json.dumps(summary))


def check_replay(owner, codes, oracle, adapters, monitors, minute, now):
    checks = 0
    for index, code in enumerate(codes):
        for monitor, adapter in zip(monitors, adapters, strict=True):
            selected = monitor.leaves[0]
            data = adapter.snapshot(selected, code, now)[0]
            if index == 0 and 120 <= minute < 122:
                assert not all(bar.valid for bar in data)
                continue
            values = [qty for _, qty in oracle[code]]
            period = selected.params.period
            expected_current = len(values) >= period and values[-1] == max(values[-period:])
            flag = owner.match_fingerprint(monitor, owner.histories[code])[-1][0]
            assert flag == expected_current
            if minute % 15 == 0 or minute == 389:
                expected = {oracle[code][j][0] for j in range(max(period-1, len(values)-5), len(values))
                            if values[j] == max(values[j-period+1:j+1])}
                actual, complete = bars.records(selected, data, fetched_at_ms=now)
                assert complete == (len(values) >= period + 4)
                assert {event.bar_start_ms for event in actual} == expected
            checks += 1
    return checks


async def test_replay_overrun_cannot_omit_a_large_missing_comparison_bar(fixture):
    from hoga.live.volume_state import MINUTE, VolumeSource

    owner, clock, _ = fixture
    monitor = await start(owner)
    history = owner.histories['005930']
    await owner.prepare('005930', history)
    source = VolumeSource('overrun')
    source.configure({'005930'})
    source.health({'005930': 'a:1'}, START)
    owner.replica.reset('overrun')
    source.ingest('005930', dict(kind='trade', venue='KRX', t_ms=clock.now, cum_volume=100,
        trades=[dict(t_ms=clock.now, qty=10)]), clock.now)
    owner.replica.apply(source.frames(clock.now)[0], clock.now)
    owner.merge('005930', history, clock.now)
    cumulative = 100
    for minute in range(1, 21):
        clock.now = START + minute * MINUTE + 1000
        qty = 9999 if minute == 2 else 2000 if minute == 20 else 1
        cumulative += qty
        source.ingest('005930', dict(kind='trade', venue='KRX', t_ms=clock.now, cum_volume=cumulative,
            trades=[dict(t_ms=clock.now, qty=qty)]), clock.now)
    # Parent receives no intermediate snapshots. The 9999-share bar has fallen
    # out of the producer replay; treating the missing interval as quiet gives
    # a false positive for the current 2000-share bar against old 1000 peaks.
    owner.replica.apply(source.frames(clock.now)[0], clock.now)
    data = ContinuousAdapter(owner, monitor).snapshot(monitor.leaves[0], '005930', clock.now)[0]
    events, _ = bars.records(monitor.leaves[0], data, fetched_at_ms=clock.now)
    assert not events


async def test_recent_closed_api_bar_is_not_canonical_until_settled(fixture):
    owner, clock, _ = fixture
    await start(owner)
    clock.now = START + 1000
    history = owner.histories['005930']
    await owner.prepare('005930', history)
    recent = next(b for b in history.bars if b.start_ms == START - 60_000)
    assert not recent.valid
    assert recent.start_ms not in history.canonical
    clock.now = START + 20_000
    await owner.prepare('005930', history)
    recent = next(b for b in history.bars if b.start_ms == START - 60_000)
    assert recent.valid
    assert recent.start_ms in history.canonical


async def test_closed_market_retains_cache_without_full_universe_polling(fixture):
    owner, clock, _ = fixture
    monitor = await start(owner)
    await owner.prepare('005930', owner.histories['005930'])
    clock.now = int(dt.datetime(2026, 10, 21, 18, tzinfo=KST).timestamp()*1000)
    owner.schedule({'005930'}, clock.now)
    assert not owner.pending
    assert owner.histories['005930'].bars
    assert not owner.market_clock(clock.now)
    assert owner.get(monitor.id).id == monitor.id


async def test_initial_failure_surfaces_reason_and_is_not_perpetual_preparing(fixture):
    owner, clock, _ = fixture
    monitor = await start(owner)
    history = owner.histories['005930']
    history.reason = 'credentials_missing'
    status = owner.status(monitor, clock.now)
    assert status.unavailable == 1
    assert status.preparing == 1  # other symbol has not been attempted
    assert ContinuousAdapter(owner, monitor).reason('005930') == 'credentials_missing'


def cache_frame(owner, clock, *, first_volume=10, first_revision=1):
    if owner.replica.epoch != 'cache':
        owner.replica.reset('cache')
    owner.replica.apply(dict(protocol=PROTOCOL, epoch='cache', observed_ms=clock.now, streams={
        code: dict(revision=first_revision if code == '005930' else 1, generation='cache:1',
            ready=True, tick_ms=clock.now, since_ms=START-60_000,
            replay_since_ms=clock.now - REPLAY_MS,
            bars=[[START, first_volume if code == '005930' else 10, True,
                   None, None, None, None, False, START, START]])
        for code in ['005930', '000660']}), clock.now)
    for code, history in owner.histories.items():
        owner.merge(code, history, clock.now)


async def test_notify_only_recomputes_changed_symbols_and_clock_or_quality_changes(fixture, monkeypatch):
    owner, clock, _ = fixture
    monitor = await start(owner, request(period=3))
    for code in monitor.codes:
        await owner.prepare(code, owner.histories[code])
    cache_frame(owner, clock)
    original, seen = owner.match_fingerprint, []
    def count(*args):
        seen.append(args[1])
        return original(*args)
    monkeypatch.setattr(owner, 'match_fingerprint', count)
    owner.notify()
    assert len(seen) == 2
    owner.notify()
    assert len(seen) == 2
    clock.now += 1000
    cache_frame(owner, clock, first_volume=2000, first_revision=2)
    owner.notify()
    assert len(seen) == 3
    clock.now = START+61_000
    for code in monitor.codes:
        owner.merge(code, owner.histories[code], clock.now)
    owner.notify()
    assert len(seen) == 5


async def test_result_cache_shares_concurrent_reads_and_only_rechecks_changed_symbol(fixture, monkeypatch):
    owner, clock, calls = fixture
    monitor = await start(owner, request(period=3))
    for code in monitor.codes:
        await owner.prepare(code, owner.histories[code])
    cache_frame(owner, clock)
    original, checked = bars.records, []
    def count(*args, **kwargs):
        checked.append(args[0].id)
        return original(*args, **kwargs)
    monkeypatch.setattr(bars, 'records', count)
    monkeypatch.setattr(bars.time, 'time', lambda: clock.now/1000)
    async def read():
        return await bars.evaluate(data_dir=owner.data_dir, conditions=monitor.leaves, codes=monitor.codes,
            basis='intraday', now=dt.datetime.fromtimestamp(clock.now/1000, KST),
            volume_runtime=ContinuousAdapter(owner, monitor))
    first, _ = await asyncio.gather(read(), read())
    assert len(checked) == 2
    first.events['v'][0][1].condition_key = 'mutated by a consumer'
    again = await read()
    assert len(checked) == 2
    assert all(event.condition_key != 'mutated by a consumer' for _, event in again.events['v'])
    clock.now += 1000
    cache_frame(owner, clock, first_volume=2000, first_revision=2)
    changed = await read()
    assert len(checked) == 3
    assert changed.coverage.complete == 2
    assert len(calls) == 2  # still just the initial per-code preparation
    clock.now += 6000  # an offline replica invalidates cached positive matches
    offline = await read()
    assert len(checked) == 5 and offline.coverage.complete == 0
    assert not offline.events['v']
