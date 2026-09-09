import datetime as dt

import polars as pl
import pytest
from pydantic import ValidationError

from hoga.api import screener_history_coverage as coverage
from hoga.api.models import HistoryJob, HistoryVolumeParams, NewHighVolLeaf, ScanRequest
from hoga.api.screener_history_storage import CommitResult, HistoryCorpusExtended, commit_verified, verified_factors
from hoga.api.screener_store import _DAILY_PL_SCHEMA


def leaf(start='2019-01-02', end='2019-01-04', unit='trading_days', value=3):
    return NewHighVolLeaf(id='volume', params=HistoryVolumeParams(
        mode='date_range', start_date=start, end_date=end,
        record_period={'unit': unit, 'value': value}))


def make_job(**fields):
    defaults = dict(id='test', request=ScanRequest(conditions=[leaf(end='2019-01-02', value=1)]),
                    codes=['005930'], status='queued', done=0, total=0, written_rows=0, errors={},
                    started_at_ms=1)
    return HistoryJob(**(defaults | fields))


def write_rows(tmp_path, days, volumes):
    rows = [dict(code='005930', date=d, open=100., high=100., low=100., close=100., volume=v)
            for d, v in zip(days, volumes, strict=True)]
    frame = pl.DataFrame(rows, schema=_DAILY_PL_SCHEMA)
    sdir = tmp_path / 'screener'
    sdir.mkdir(exist_ok=True)
    frame.write_parquet(sdir / 'daily_adjusted.parquet')
    pl.DataFrame(dict(code=['005930'], seg_start=[min(days)], factor=[1.])).write_parquet(
        sdir / 'factors.parquet')
    return frame


def test_full_window_and_future_does_not_change_match(tmp_path, monkeypatch):
    days = [dt.date(2018, 12, 27), dt.date(2018, 12, 28), dt.date(2019, 1, 2),
            dt.date(2019, 1, 3), dt.date(2019, 1, 4), dt.date(2023, 1, 2)]
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.strftime('%Y%m%d') for d in days])
    write_rows(tmp_path, days, [1000, 10, 100, 200, 200, 999999])
    result = coverage.evaluate(tmp_path, [leaf()], ['005930'])
    assert result.coverage.complete == 1
    assert result.matches['005930'][0].date == '2019-01-04'
    assert result.matches['005930'][0].volume == 200


def test_missing_day_is_unknown_not_a_record(tmp_path, monkeypatch):
    days = [dt.date(2019, 1, d) for d in (2, 3, 4)]
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.strftime('%Y%m%d') for d in days])
    write_rows(tmp_path, [days[0], days[2]], [1, 100])
    result = coverage.evaluate(tmp_path, [leaf(start='2019-01-04')], ['005930'])
    assert result.passing['volume'] == []
    assert result.coverage.incomplete[0].missing_days == 1


def test_year_boundary_is_exclusive_and_leap_day(tmp_path, monkeypatch):
    days = [dt.date(2017, 1, 2), dt.date(2017, 1, 3), dt.date(2019, 1, 2)]
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.strftime('%Y%m%d') for d in days])
    write_rows(tmp_path, days, [1000, 10, 20])
    result = coverage.evaluate(tmp_path, [leaf(end='2019-01-02', unit='years', value=2)], ['005930'])
    assert result.passing['volume'] == ['005930']
    assert coverage.subtract_years(dt.date(2020, 2, 29), 1) == dt.date(2019, 2, 28)


def test_zero_volume_not_a_record(tmp_path, monkeypatch):
    days = [dt.date(2019, 1, 2)]
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])
    write_rows(tmp_path, days, [0])
    assert not coverage.evaluate(tmp_path, [leaf(end='2019-01-02', value=1)], ['005930']).passing['volume']


def test_old_params_survive_and_bad_date_mode_cannot_fall_back():
    assert NewHighVolLeaf(id='v', params={'lookback': 10, 'period': 500}).params.period == 500
    with pytest.raises(ValidationError):
        NewHighVolLeaf(id='v', params={'mode': 'date_range', 'lookback': 10, 'period': 500})
    with pytest.raises(ValidationError):
        leaf(start='2022-12-31', end='2019-01-01')


def test_split_volume_persisted_and_reused(tmp_path):
    raw = write_rows(tmp_path, [dt.date(2017, 1, 2), dt.date(2018, 5, 4)], [10, 500])
    raw = raw.with_columns(pl.Series('close', [5000., 100.]), pl.Series('open', [5000., 100.]),
                           pl.Series('high', [5000., 100.]), pl.Series('low', [5000., 100.]))
    adj = raw.with_columns(pl.lit(100.).alias('close'), pl.lit(100.).alias('open'),
                           pl.lit(100.).alias('high'), pl.lit(100.).alias('low'),
                           pl.lit(500).cast(pl.Int64).alias('volume'))
    assert commit_verified(tmp_path, [(raw, adj)]).written_rows == 2
    assert commit_verified(tmp_path, [(raw, adj)]).written_rows == 0
    saved = pl.read_parquet(tmp_path / 'screener/daily_adjusted.parquet')
    assert saved['volume'].to_list() == [500, 500]
    with pytest.raises(ValueError, match='adjusted_volume_mismatch'):
        verified_factors(raw, adj.with_columns(pl.lit(600).alias('volume')))


@pytest.mark.asyncio
async def test_runner_returns_evidence_and_skips_intraday_for_historical_only(tmp_path, monkeypatch):
    from hoga.api import screener_intraday
    from hoga.api.models import ScanRequest
    from hoga.api.screener_runner import run_screener_scan

    write_rows(tmp_path, [dt.date(2019, 1, 2)], [100])
    (tmp_path / 'screener/status.json').write_text('{}')
    pl.DataFrame(dict(code=['005930'], name=['삼성전자'], market=['KOSPI'],
                      is_etf=[False], is_halted=[False])).write_parquet(tmp_path / 'screener/stocks.parquet')
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])

    async def forbidden(**kwargs):
        raise AssertionError('historical scan must not fetch intraday')

    monkeypatch.setattr(screener_intraday, 'build_intraday_overlay', forbidden)
    result = await run_screener_scan(data_dir=tmp_path, req=ScanRequest(
        conditions=[leaf(end='2019-01-02', value=1)], basis='intraday'))
    assert result.rows[0].history_matches[0].date == '2019-01-02'
    assert result.history_coverage.complete == 1


@pytest.mark.asyncio
async def test_job_cancel_survives_save_and_resume_uses_disk(tmp_path, monkeypatch):
    from hoga.api import screener_history_jobs as jobs
    from hoga.api.models import ScanRequest

    days = [dt.date(2019, 1, 2)]
    raw = write_rows(tmp_path, days, [100])
    (tmp_path / 'screener/daily_adjusted.parquet').unlink()
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])
    req = ScanRequest(conditions=[leaf(end='2019-01-02', value=1)])
    job = make_job(id='test', request=req.model_dump(mode='json'), codes=['005930'], status='queued',
               done=0, total=0, written_rows=0, errors={})
    calls = []

    async def fetch(*args):
        calls.append(args)
        return raw, raw

    jobs._save(tmp_path, job)
    await jobs.run_job(tmp_path, job, fetch)
    assert job.status == 'complete'
    assert len(calls) == 1
    await jobs.run_job(tmp_path, job, fetch)
    assert len(calls) == 1
    job.status = 'collecting'
    jobs._save(tmp_path, job)
    cancelled = job.model_copy(update={'cancel_requested': True})
    jobs._save(tmp_path, cancelled)
    jobs._save(tmp_path, job)
    assert jobs.load_job(tmp_path).cancel_requested is True


def test_publication_recovers_before_next_writer(tmp_path, monkeypatch):
    import json
    import os

    from hoga.api.screener_write_lock import publish_history, screener_write_lock

    sdir, stage = tmp_path / 'screener', tmp_path / 'stage'
    sdir.mkdir()
    stage.mkdir()
    for name in ('daily_unadjusted.parquet', 'factors.parquet', 'daily_adjusted.parquet'):
        (stage / name).write_text('new')
        (sdir / name).write_text('old')
    replace = os.replace

    def fail(src, dst):
        if str(dst).endswith('factors.parquet'):
            raise OSError('simulated disk error')
        return replace(src, dst)

    with monkeypatch.context() as m:
        m.setattr(os, 'replace', fail)
        with pytest.raises(OSError), screener_write_lock(sdir):
            publish_history(sdir, stage)
    assert (sdir / 'daily_adjusted.parquet').read_text() == 'old'
    assert json.loads((sdir / 'history_publish.json').read_text())['files']
    with screener_write_lock(sdir):
        assert (sdir / 'daily_adjusted.parquet').read_text() == 'new'
    assert not (sdir / 'history_publish.json').exists()


@pytest.mark.asyncio
async def test_history_job_http_contract_deduplicates_and_cancels(tmp_path, monkeypatch):
    import asyncio

    import httpx
    from fastapi import FastAPI

    from hoga.api import screener_history_jobs as jobs

    write_rows(tmp_path, [dt.date(2019, 1, 2)], [100])
    pl.DataFrame(dict(code=['005930'], name=['삼성전자'], market=['KOSPI'],
                      is_etf=[False], is_halted=[False])).write_parquet(tmp_path / 'screener/stocks.parquet')
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])
    release = asyncio.Event()

    async def held(directory, job):
        await release.wait()
        job.status = 'interrupted'
        jobs._save(directory, job)

    monkeypatch.setattr(jobs, 'run_job', held)
    app = FastAPI()
    app.include_router(jobs.build_router(tmp_path))
    body = {'conditions': [leaf(end='2019-01-02', value=1).model_dump(mode='json')]}
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        assert (await client.get('/history/jobs/current')).json() is None
        preview = await client.post('/history/preview', json=body)
        assert preview.json()['complete'] == 1
        first = await client.post('/history/jobs', json=body)
        assert first.status_code == 200
        job = first.json()
        assert job['codes'] == ['005930']
        assert job['cancel_requested'] is False
        assert (await client.post('/history/jobs', json=body)).json()['id'] == job['id']
        different = {'conditions': [leaf(end='2019-01-03', value=1).model_dump(mode='json')]}
        assert (await client.post('/history/jobs', json=different)).status_code == 409
        cancelled = await client.post(f'/history/jobs/{job["id"]}/cancel')
        assert cancelled.json()['cancel_requested'] is True
        release.set()
        await jobs._tasks[str(tmp_path)]
        assert (await client.get('/history/jobs/current')).json()['status'] == 'interrupted'


@pytest.mark.parametrize(('hour', 'expected'), [(15, '2026-09-08'), (16, '2026-09-09')])
def test_history_uses_existing_eod_cutoff(monkeypatch, hour, expected):
    from hoga.api import screener_history_jobs as jobs

    class Clock(dt.datetime):
        @classmethod
        def now(cls, tz=None):
            return cls(2026, 9, 9, hour, tzinfo=tz)

    monkeypatch.setattr(jobs.dt, 'datetime', Clock)
    assert jobs.completed_day().isoformat() == expected


@pytest.mark.asyncio
@pytest.mark.parametrize('concurrent_extension', [False, True])
async def test_history_preserves_latest_disk_day_and_refetches_extension(tmp_path, monkeypatch, concurrent_extension):
    import fcntl

    from hoga.api import screener_history_jobs as jobs
    from hoga.api.models import ScanRequest

    old, yesterday, today = dt.date(2019, 1, 2), dt.date(2026, 9, 8), dt.date(2026, 9, 9)
    full = write_rows(tmp_path, [old, yesterday, today], [100, 100, 100])
    existing = full.filter(pl.col('date') == (yesterday if concurrent_extension else today))
    up = tmp_path / 'screener/daily_unadjusted.parquet'
    existing.write_parquet(up)
    existing.write_parquet(tmp_path / 'screener/daily_adjusted.parquet')
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102', '20260908', '20260909'])
    monkeypatch.setattr(jobs, 'completed_day', lambda: yesterday if concurrent_extension else today)
    req = ScanRequest(conditions=[leaf(end='2019-01-02', value=1)])
    job = make_job(id='latest', request=req.model_dump(mode='json'), codes=['005930'], status='queued',
               done=0, total=0, written_rows=0, errors={})
    calls = []

    async def fetch(directory, code, start, end):
        calls.append((start, end))
        # The bounded retry must release the publication lock before calling REST.
        with (directory / 'screener/.writer.lock').open('a') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
        if concurrent_extension and len(calls) == 1:
            full.filter(pl.col('date') >= yesterday).write_parquet(up)
        selected = full.filter(pl.col('date').is_between(start, end))
        return selected, selected

    jobs._save(tmp_path, job)
    await jobs.run_job(tmp_path, job, fetch)
    assert job.status == 'complete'
    assert job.errors == {}
    assert calls == ([(old, yesterday), (old, today)] if concurrent_extension else [(old, today)])
    saved = pl.read_parquet(tmp_path / 'screener/daily_adjusted.parquet')
    assert saved['date'].to_list() == [old, yesterday, today]


@pytest.mark.asyncio
async def test_history_extension_retry_is_bounded(tmp_path, monkeypatch):
    from hoga.api import screener_history_jobs as jobs

    day = dt.date(2019, 1, 2)
    raw = write_rows(tmp_path, [day], [100])
    job = make_job(id='bounded', status='queued', written_rows=0, errors={})
    attempts = []

    def commit(*args):
        attempts.append('commit')
        return CommitResult(extensions={'005930': HistoryCorpusExtended('005930', day, day)})

    async def fetch(*args):
        attempts.append('fetch')
        return raw, raw

    monkeypatch.setattr(jobs, 'commit_verified', commit)
    await jobs.flush_batch(tmp_path, job, [(raw, raw)], fetch)
    assert attempts == ['commit', 'fetch', 'commit', 'fetch', 'commit']
    assert job.written_rows == 0
    assert job.errors == {'005930': 'history_changed_during_collection'}


@pytest.mark.asyncio
async def test_history_extension_retries_are_bounded_per_code(tmp_path, monkeypatch):
    from hoga.api import screener_history_jobs as jobs

    old, latest = dt.date(2019, 1, 2), dt.date(2019, 1, 3)
    template = write_rows(tmp_path, [old, latest], [100, 100])
    codes = ['005930', '000660', '005380']
    frames = {code: template.with_columns(pl.lit(code).alias('code')) for code in codes}
    pl.concat([frame.filter(pl.col('date') == latest) for frame in frames.values()]).write_parquet(
        tmp_path / 'screener/daily_unadjusted.parquet')
    pending = [(frame.head(1), frame.head(1)) for frame in frames.values()]
    job = make_job(id='multiple', status='queued', written_rows=0, errors={})
    calls = []
    monkeypatch.setattr(jobs, 'completed_day', lambda: latest)

    async def fetch(directory, code, start, end):
        calls.append(code)
        assert (start, end) == (old, latest)
        return frames[code], frames[code]

    await jobs.flush_batch(tmp_path, job, pending, fetch)
    assert calls == codes
    assert job.errors == {}
    assert job.written_rows == 3
    saved = pl.read_parquet(tmp_path / 'screener/daily_adjusted.parquet')
    assert saved.height == 6
    assert saved['code'].n_unique() == 3
