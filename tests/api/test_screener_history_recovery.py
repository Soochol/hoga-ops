import datetime as dt
import json

import polars as pl
import pytest

from hoga.api import screener_factors, screener_history_coverage as coverage, screener_history_jobs as jobs
from hoga.api.models import ScanRequest
from hoga.api.screener_store import _DAILY_PL_SCHEMA


def request():
    return ScanRequest.model_validate({'conditions': [{'id': 'v', 'type': 'new_high_vol', 'params': {
        'mode': 'date_range', 'start_date': '2019-01-02', 'end_date': '2019-01-02',
        'record_period': {'unit': 'trading_days', 'value': 1},
    }}]})


def job():
    return dict(id='resume', request=request().model_dump(mode='json'), codes=['005930'],
                status='queued', done=0, total=0, written_rows=0, errors={})


def frame():
    return pl.DataFrame([dict(code='005930', date=dt.date(2019, 1, 2), open=100., high=100.,
                              low=100., close=100., volume=100)], schema=_DAILY_PL_SCHEMA)


@pytest.mark.asyncio
async def test_resume_recovers_staged_publication_without_vendor(tmp_path, monkeypatch):
    sdir = tmp_path / 'screener'
    sdir.mkdir()
    raw = frame()
    raw.write_parquet(sdir / 'daily_unadjusted.parquet')
    screener_factors.write_factors(jobs.verified_factors(raw, raw), sdir / 'factors.parquet')
    raw.write_parquet(sdir / 'daily_adjusted.parquet.history-pending')
    (sdir / 'history_publish.json').write_text(json.dumps({'files': ['daily_adjusted.parquet']}))
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])

    async def unavailable(*args):
        raise AssertionError('completed staged publication must not fetch again')

    state = job()
    await jobs.run_job(tmp_path, state, unavailable)
    assert state['status'] == 'complete'
    assert not state['errors']
    assert state['coverage']['complete'] == 1
    assert not (sdir / 'history_publish.json').exists()


@pytest.mark.asyncio
async def test_missing_factors_are_collected_even_with_all_dates(tmp_path, monkeypatch):
    sdir = tmp_path / 'screener'
    sdir.mkdir()
    raw = frame()
    raw.write_parquet(sdir / 'daily_adjusted.parquet')
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102'])
    calls = []

    async def fetch(*args):
        calls.append(args)
        return raw, raw

    state = job()
    await jobs.run_job(tmp_path, state, fetch)
    assert len(calls) == 1
    assert state['status'] == 'complete'
    assert (sdir / 'factors.parquet').exists()
