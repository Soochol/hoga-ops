import asyncio
from contextlib import asynccontextmanager

import pytest
from fastapi import HTTPException

from hoga.api import screener_bar_volume as bars, screener_rankings, screener_runner
from hoga.api.models import ScanRequest
from hoga.api.screener_continuous import ContinuousAdapter, ContinuousMonitors
from hoga.live.buffer import LiveBuffer
from tests.api.test_screener_continuous import START, request


@asynccontextmanager
async def dispatch(tmp_path, count=12):
    codes = [f'{i:06d}' for i in range(count)]
    started, active = [], set()
    maximum = 0
    release = {code: asyncio.Event() for code in codes}

    async def targets(_codes):
        pass

    async def loader(_dir, code, _frame, needed, _lower, _asof):
        nonlocal maximum
        started.append(code)
        active.add(code)
        maximum = max(maximum, len(active))
        try:
            await release[code].wait()
            data = [bars.VolumeBar(START - (needed-i)*60_000, 100, open=100, high=100, low=100, close=100)
                    for i in range(needed)]
            return bars.MinuteSnapshot(data, START + 20_000)
        finally:
            active.remove(code)

    owner = ContinuousMonitors(tmp_path, None, LiveBuffer(), targets, loader=loader, now=lambda: START + 20_000)

    async def resolve(_req):
        return codes

    owner.resolve = resolve
    status = await owner.start('dispatch', request(period=5))
    owner.loop_task.cancel()
    await asyncio.gather(owner.loop_task, return_exceptions=True)
    owner.loop_task = None
    try:
        yield owner, owner.get(status.id), codes, started, release, lambda: maximum
    finally:
        await owner.close()


async def turns():
    for _ in range(8):
        await asyncio.sleep(0)


async def test_completed_slot_starts_next_without_another_periodic_scan(tmp_path, monkeypatch):
    async with dispatch(tmp_path) as (owner, _monitor, codes, started, release, maximum):
        owner.schedule(set(codes), owner.now())
        await turns()
        assert len(started) == 4
        monkeypatch.setattr(owner, 'monitor_quality', lambda *_: pytest.fail('Completion must not rescan quality'))
        monkeypatch.setattr(owner, 'notify', lambda: pytest.fail('Completion must not rerun notifications'))
        release[started[0]].set()
        await turns()
        assert len(started) == 5
        assert maximum() == 4


async def test_candidates_lead_and_ordinary_codes_keep_progress(tmp_path):
    async with dispatch(tmp_path, 16) as (owner, monitor, codes, started, release, maximum):
        preferred = set(codes[4:])
        monitor.request = ScanRequest.model_validate(dict(conditions=[
            dict(id='v', type='new_high_vol', params=dict(timeframe='1m', period=5, lookback=1)),
            dict(id='r', type='trade_value_rank', params=dict(top_n=300))], expression='A AND B',
            universe=dict(scopes=['watchlist']), basis='intraday'))
        rank = screener_rankings.RankEvaluation({'r': [(code, None) for code in preferred]}, owner.now())
        ContinuousAdapter(owner, monitor).prioritize_rank_candidates(rank)
        owner.schedule(set(codes), owner.now())
        await turns()
        assert len(set(started[:4]) & preferred) == 3
        assert len(set(started[:4]) - preferred) == 1
        while len(started) < len(codes):
            for code in list(started):
                release[code].set()
            await turns()
        assert len(started) == len(set(started)) == len(codes)
        assert maximum() == 4


async def test_stopped_scope_is_not_dispatched_by_completion(tmp_path):
    async with dispatch(tmp_path) as (owner, monitor, codes, started, release, _maximum):
        owner.schedule(set(codes), owner.now())
        await turns()
        owner.stop(monitor.id)
        release[started[0]].set()
        await turns()
        assert len(started) == 4


async def test_shutdown_does_not_refill_pending_preparations(tmp_path):
    async with dispatch(tmp_path) as (owner, _monitor, codes, started, release, _maximum):
        owner.schedule(set(codes), owner.now())
        await turns()
        owner.begin_read_shutdown()
        release[started[0]].set()
        await turns()
        assert len(started) == 4


async def test_rank_failure_clears_previous_candidate_priority(tmp_path, monkeypatch):
    async with dispatch(tmp_path) as (owner, monitor, _codes, _started, _release, _maximum):
        adapter = ContinuousAdapter(owner, monitor)
        seen = []
        setter = adapter.prioritize_rank_candidates

        def record(value):
            seen.append(value)
            setter(value)

        adapter.prioritize_rank_candidates = record

        async def failed(*_args, **_kwargs):
            raise HTTPException(503, 'rank unavailable')

        monkeypatch.setattr(screener_rankings, 'evaluate', failed)
        with pytest.raises(HTTPException):
            await screener_runner.run_screener_scan(data_dir=tmp_path, req=monitor.request, volume_runtime=adapter)
        assert seen == [None]
