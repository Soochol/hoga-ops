import asyncio
import datetime as dt

import pytest
from pydantic import TypeAdapter

from hoga.api import screener_bar_volume as volume
from hoga.api.models import ConditionLeaf
from hoga.util.timeenc import KST

NOW = dt.datetime(2026, 10, 21, 13, 0, 20, tzinfo=KST)
STAMP = int(NOW.timestamp() * 1000)


def condition():
    return TypeAdapter(ConditionLeaf).validate_python(dict(id='queue', type='new_high_vol',
        params=dict(timeframe='1m', period=2, lookback=1)))


def evaluate(tmp_path, code, semaphore):
    return volume._evaluate_minute_window(condition(), code, data_dir=tmp_path,
        as_of=NOW, now=NOW, basis='intraday', fetch_codes={code}, sem=semaphore, volume_runtime=None)


def snapshot():
    return volume.MinuteSnapshot([volume.VolumeBar(STAMP // 60_000 * 60_000 - 60_000, 10),
        volume.VolumeBar(STAMP // 60_000 * 60_000, 20, is_open=True)], STAMP)


async def test_fifth_admission_wait_cannot_expire_before_vendor_starts(tmp_path, monkeypatch):
    sem = asyncio.Semaphore(4)
    started, release = asyncio.Event(), asyncio.Event()
    entered = []
    real_timeout = asyncio.timeout

    def admitted_timeout(seconds):
        return real_timeout(0 if sem.locked() else seconds)

    async def loader(_dir, code, *_args, **_kwargs):
        entered.append(code)
        if len(entered) == 4:
            started.set()
        await release.wait()
        return snapshot()

    monkeypatch.setattr(volume, 'minute_snapshot', loader)
    monkeypatch.setattr(volume.asyncio, 'timeout', admitted_timeout)
    tasks = [asyncio.create_task(evaluate(tmp_path, f'{index:06d}', sem)) for index in range(5)]
    try:
        await started.wait()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert not tasks[-1].done(), 'queued Code became fetch_timeout before transport admission'
        assert len(entered) == 4
        release.set()
        results = await asyncio.gather(*tasks)
        assert len(entered) == 5
        assert all(result[3] and result[4] is None for result in results)
    finally:
        release.set()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_true_loader_timeout_remains_a_fetch_timeout(tmp_path, monkeypatch):
    async def loader(*_args, **_kwargs):
        raise TimeoutError('actual vendor transport expired')

    monkeypatch.setattr(volume, 'minute_snapshot', loader)
    result = await evaluate(tmp_path, '005930', asyncio.Semaphore(1))
    assert result[2:] == ([], False, 'fetch_timeout')


async def test_cancelling_an_admission_wait_does_not_cancel_another_code(tmp_path, monkeypatch):
    sem = asyncio.Semaphore(0)
    entered = []

    async def loader(_dir, code, *_args, **_kwargs):
        entered.append(code)
        return snapshot()

    monkeypatch.setattr(volume, 'minute_snapshot', loader)
    abandoned = asyncio.create_task(evaluate(tmp_path, '005930', sem))
    retained = asyncio.create_task(evaluate(tmp_path, '000660', sem))
    await asyncio.sleep(0)
    abandoned.cancel()
    with pytest.raises(asyncio.CancelledError):
        await abandoned
    sem.release()
    assert (await retained)[3:5] == (True, None)
    assert entered == ['000660']
