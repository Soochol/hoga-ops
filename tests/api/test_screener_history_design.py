"""History planning, failure isolation, and shared-window algorithm regressions."""
import datetime as dt
import random

import polars as pl
import pytest

from hoga.api import (
    screener_history_coverage as coverage,
    screener_history_jobs as jobs,
    screener_history_storage as storage,
)
from hoga.api.models import HistoryVolumeParams, NewHighVolLeaf, ScanRequest
from hoga.api.screener_history_state import JobCheckpoint, create_job
from hoga.api.screener_store import _DAILY_PL_SCHEMA


def leaf(start='2008-01-01', end='2010-01-04', unit='years', value=2):
    return NewHighVolLeaf(id='v', params=HistoryVolumeParams(mode='date_range', start_date=start,
        end_date=end, record_period={'unit': unit, 'value': value}))


def frame(code, days, volume=100):
    return pl.DataFrame([dict(code=code, date=d, open=100., high=100., low=100., close=100., volume=volume)
                         for d in days], schema=_DAILY_PL_SCHEMA)


@pytest.mark.asyncio
async def test_partial_calendar_collects_supported_windows_and_resume_does_not_refetch(tmp_path, monkeypatch):
    days = [dt.date(2007, 1, 2), dt.date(2008, 1, 2), dt.date(2009, 1, 5), dt.date(2010, 1, 4)]
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.strftime('%Y%m%d') for d in days])
    request = ScanRequest(conditions=[leaf()])
    job = create_job(request, ['005930'])
    calls = []

    async def fetch(directory, code, start, end):
        calls.append(start)
        raw = frame(code, [d for d in days if start <= d <= end])
        return raw, raw

    await jobs.run_job(tmp_path, job, fetch)
    assert len(calls) == 1
    assert calls[0] >= days[0]
    assert job.status == 'partial'
    assert not job.errors
    result = coverage.evaluate(tmp_path, request.conditions, job.codes)
    assert result.matches['005930'][0].date == '2010-01-04'
    assert result.coverage.incomplete[0].reason == 'calendar_unavailable'
    assert not result.collection_starts
    await jobs.run_job(tmp_path, create_job(request, job.codes), fetch)
    assert len(calls) == 1


@pytest.mark.asyncio
async def test_no_complete_calendar_window_does_not_trigger_useless_collection(tmp_path, monkeypatch):
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20070102', '20080102'])
    job = create_job(ScanRequest(conditions=[leaf(end='2008-01-02')]), ['005930'])

    async def forbidden(*args):
        raise AssertionError('no supported candidate window')

    await jobs.run_job(tmp_path, job, forbidden)
    assert job.status == 'partial'
    assert job.total == 0
    assert not job.errors


@pytest.mark.asyncio
async def test_invalid_existing_code_does_not_discard_healthy_batch_members(tmp_path):
    days = [dt.date(2019, 1, 2), dt.date(2019, 1, 3)]
    good, bad = frame('005930', days), frame('000660', days)
    sdir = tmp_path / 'screener'
    sdir.mkdir()
    # Vendor pairs each validate, but one disagrees with an authoritative disk row.
    existing = frame('000660', days[1:], volume=99)
    existing.write_parquet(sdir / 'daily_unadjusted.parquet')
    job = create_job(ScanRequest(conditions=[leaf()]), ['005930', '000660'])
    await jobs.flush_batch(tmp_path, job, [(good, good), (bad, bad)])
    assert job.written_rows == 2
    assert job.errors == {'000660': 'adjusted_volume_mismatch'}
    saved = pl.read_parquet(sdir / 'daily_unadjusted.parquet')
    assert saved.filter(pl.col('code') == '005930').height == 2
    assert saved.filter(pl.col('code') == '000660').equals(existing)
    assert JobCheckpoint(tmp_path).load().errors == job.errors


@pytest.mark.asyncio
async def test_failed_extension_refetch_does_not_discard_other_extended_codes(tmp_path, monkeypatch):
    days = [dt.date(2019, 1, 2), dt.date(2019, 1, 3)]
    frames = {code: frame(code, days) for code in ['005930', '000660']}
    sdir = tmp_path / 'screener'
    sdir.mkdir()
    pl.concat([f.tail(1) for f in frames.values()]).write_parquet(sdir / 'daily_unadjusted.parquet')
    monkeypatch.setattr(jobs, 'completed_day', lambda: days[-1])
    job = create_job(ScanRequest(conditions=[leaf()]), list(frames))

    async def fetch(directory, code, start, end):
        if code == '000660':
            raise ValueError('vendor_unavailable')
        return frames[code], frames[code]

    await jobs.flush_batch(tmp_path, job, [(f.head(1), f.head(1)) for f in frames.values()], fetch)
    assert job.written_rows == 1
    assert job.errors == {'000660': 'vendor_unavailable'}
    saved = pl.read_parquet(sdir / 'daily_adjusted.parquet')
    assert saved.filter(pl.col('code') == '005930').height == 2


@pytest.mark.asyncio
async def test_publication_failure_still_fails_entire_batch(tmp_path, monkeypatch):
    pair = frame('005930', [dt.date(2019, 1, 2)])
    job = create_job(ScanRequest(conditions=[leaf()]), ['005930'])

    def fail(*args):
        raise OSError('disk full')

    monkeypatch.setattr(storage, 'publish_history', fail)
    await jobs.flush_batch(tmp_path, job, [(pair, pair)])
    assert job.written_rows == 0
    assert job.errors == {'005930': 'disk full'}
    assert not (tmp_path / 'screener/daily_unadjusted.parquet').exists()


@pytest.mark.parametrize('unit', ['years', 'trading_days'])
def test_precomputed_windows_match_independent_brute_force(unit):
    rng = random.Random(1788)
    days = [dt.date(2015, 1, 1) + dt.timedelta(days=i) for i in range(1300)]
    calendar = [d for d in days if d.weekday() < 5]
    for _ in range(30):
        start, end = calendar[600], calendar[-1]
        n = rng.choice([1, 2]) if unit == 'years' else rng.choice([1, 3, 20, 250])
        condition = leaf(start.isoformat(), end.isoformat(), unit, n)
        plan = coverage.plan_windows(condition, calendar)
        values = {d: rng.randrange(6) for d in calendar if rng.random() > .01}
        expected = None
        for i, day in enumerate(calendar):
            if day < start:
                continue
            if unit == 'years':
                boundary = day.replace(year=day.year - n)
                if boundary < calendar[0]:
                    continue
                window = [d for d in calendar[:i + 1] if d > boundary]
            else:
                window = calendar[max(0, i - n + 1):i + 1]
                if len(window) < n:
                    continue
            if any(d not in values for d in window):
                continue
            if values[day] > 0 and values[day] == max(values[d] for d in window):
                expected = day.isoformat()
        actual = coverage.latest_match(plan, values)
        assert (actual.date if actual else None) == expected
