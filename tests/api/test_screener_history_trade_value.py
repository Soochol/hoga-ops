import datetime as dt

import httpx
import polars as pl
import pytest
from fastapi import FastAPI
from pydantic import ValidationError

from hoga.api import (
    screener_history_coverage as coverage,
    screener_history_jobs as jobs,
    screener_intraday,
    screener_saves,
)
from hoga.api.models import (
    HistoryTradeValueParams,
    NewHighVolLeaf,
    ScanRequest,
    ScreenerResponse,
    ScreenerSaveWriteRequest,
    TradeValuePeriodLeaf,
)
from hoga.api.screener_history_state import create_job
from hoga.api.screener_runner import run_screener_scan
from hoga.api.screener_store import _DAILY_PL_SCHEMA


def leaf(start='2019-01-02', end='2019-01-04', min_eok=1, id='tv'):
    return TradeValuePeriodLeaf(id=id, params=HistoryTradeValueParams(
        mode='date_range', start_date=start, end_date=end, min_eok=min_eok))


def frame(code, dates, amounts):
    # OHLC mean is 10, close is 5: catches accidental close*volume substitution.
    return pl.DataFrame([dict(code=code, date=dt.date.fromisoformat(day), open=10., high=20., low=5., close=5.,
                             volume=int(amount / 10)) for day, amount in zip(dates, amounts, strict=True)],
                        schema=_DAILY_PL_SCHEMA)


def seed(tmp_path, frames):
    sdir = tmp_path / 'screener'
    sdir.mkdir(exist_ok=True)
    data = pl.concat(frames)
    data.write_parquet(sdir / 'daily_adjusted.parquet')
    codes = sorted(set(data['code']))
    pl.DataFrame(dict(code=codes, seg_start=[data['date'].min()] * len(codes),
                      factor=[1.] * len(codes))).write_parquet(sdir / 'factors.parquet')
    pl.DataFrame(dict(code=codes, name=codes, market=['KOSPI'] * len(codes), is_etf=[False] * len(codes),
                      is_halted=[False] * len(codes))).write_parquet(sdir / 'stocks.parquet')
    (sdir / 'status.json').write_text('{}')


def test_inclusive_dates_latest_event_and_daily_amount_not_period_sum(tmp_path, monkeypatch):
    days = ['2018-12-31', '2019-01-02', '2019-01-03', '2019-01-04', '2023-01-02']
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.replace('-', '') for d in days])
    seed(tmp_path, [
        frame('005930', days, [9e8, 1e8, .5e8, 1e8, 9e8]),
        frame('000660', days, [9e8, .6e8, .6e8, .6e8, 9e8]),
    ])
    result = coverage.evaluate(tmp_path, [leaf()], ['005930', '000660'])
    assert result.coverage.complete == 2
    assert result.passing['tv'] == ['005930']
    assert result.matches['005930'][0].date == '2019-01-04'
    assert result.matches['005930'][0].trade_value_won == 1e8
    # The beginning is inclusive too; no two-year warmup belongs to this condition.
    first = coverage.evaluate(tmp_path, [leaf(end='2019-01-02')], ['005930'])
    assert first.matches['005930'][0].date == '2019-01-02'
    assert first.coverage.complete == 1


def test_missing_days_remain_partial_but_known_event_survives(tmp_path, monkeypatch):
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: ['20190102', '20190103', '20190104'])
    seed(tmp_path, [frame('005930', ['2019-01-02', '2019-01-04'], [1e8, 2e8])])
    result = coverage.evaluate(tmp_path, [leaf()], ['005930'])
    assert result.matches['005930'][0].date == '2019-01-04'
    assert result.coverage.complete == 0
    assert result.coverage.incomplete[0].missing_days == 1
    assert result.collection_starts == {'005930': dt.date(2019, 1, 2)}


@pytest.mark.parametrize('params', [
    {'mode': 'date_range', 'lookback': 60, 'min_eok': 1},
    {'mode': 'date_range', 'start_date': '2019-01-04', 'end_date': '2019-01-02', 'min_eok': 1},
    {'mode': 'date_range', 'start_date': '20190102', 'end_date': '2019-01-04', 'min_eok': 1},
    {'mode': 'date_range', 'start_date': '2019-01-02', 'end_date': '2999-01-04', 'min_eok': 1},
    {'mode': 'date_range', 'start_date': '2019-01-02', 'end_date': '2019-01-04', 'min_eok': -1},
    {'mode': 'date_range', 'start_date': '2019-01-02', 'end_date': '2019-01-04', 'min_eok': 1, 'lookback': 60},
])
def test_invalid_date_params_cannot_fall_back_to_recent(params):
    with pytest.raises(ValidationError):
        TradeValuePeriodLeaf(id='tv', params=params)


@pytest.mark.asyncio
async def test_collection_preview_disk_reuse_and_real_scan_wire(tmp_path, monkeypatch):
    days = ['2019-01-02', '2019-01-03', '2019-01-04']
    raw = frame('005930', days, [.5e8, 1e8, 2e8])
    seed(tmp_path, [raw.tail(1)])
    monkeypatch.setattr(coverage.trading_days, 'trading_days', lambda _: [d.replace('-', '') for d in days])
    async def forbidden(**kwargs):
        raise AssertionError("date-only conditions must not fetch intraday")

    monkeypatch.setattr(screener_intraday, 'build_intraday_overlay', forbidden)
    request = ScanRequest(conditions=[leaf()], basis='intraday')
    calls = []

    async def fetch(directory, code, start, end):
        calls.append((code, start))
        return raw, raw

    app = FastAPI()
    app.include_router(jobs.build_router(tmp_path))

    @app.post('/scan')
    async def scan(req: ScanRequest) -> ScreenerResponse:
        return await run_screener_scan(data_dir=tmp_path, req=req)

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url='http://test') as client:
        preview = await client.post('/history/preview', json=request.model_dump(mode='json'))
        assert preview.status_code == 200
        assert preview.json()['incomplete'][0]['required_from'] == '2019-01-02'
        assert calls == []
        job = create_job(request, ['005930'])
        await jobs.run_job(tmp_path, job, fetch)
        assert job.status == 'complete'
        assert calls == [('005930', dt.date(2019, 1, 2))]
        await jobs.run_job(tmp_path, create_job(request, ['005930']), fetch)
        assert len(calls) == 1
        result = await client.post('/scan', json=request.model_dump(mode='json'))
        assert result.status_code == 200
        assert result.json()['rows'][0]['history_matches'] == [
            {'condition_id': 'tv', 'date': '2019-01-04', 'trade_value_won': 2e8}]
        mixed = request.model_copy(update={'conditions': [leaf(), NewHighVolLeaf(id='volume', params={
            'mode': 'date_range', 'start_date': '2019-01-02', 'end_date': '2019-01-04',
            'record_period': {'unit': 'trading_days', 'value': 1}})]})
        combined = await client.post('/scan', json=mixed.model_dump(mode='json'))
        assert combined.status_code == 200
        matches = combined.json()['rows'][0]['history_matches']
        assert len(matches) == 2
        assert matches[0]['trade_value_won'] == 2e8
        assert matches[1]['volume'] == 20000000
        # Legacy recent N days uses the same estimator and remains accepted.
        recent = await client.post('/scan', json={'conditions': [
            {'id': 'old', 'type': 'trade_value_period', 'params': {'lookback': 1, 'min_eok': 2}}]})
        assert recent.status_code == 200
        assert recent.json()['rows'][0]['code'] == '005930'
        assert recent.json()['history_coverage'] is None


@pytest.mark.asyncio
async def test_saved_new_and_old_conditions_roundtrip_without_migration(tmp_path):
    conditions = [('new', leaf()),
                  ('old', TradeValuePeriodLeaf(id='old', params={'lookback': 60, 'min_eok': 3}))]
    for id, condition in conditions:
        await screener_saves.create_save(tmp_path, id=id, now_ms=1,
            req=ScreenerSaveWriteRequest(name=id, conditions=[condition]))
    loaded = screener_saves.load_saves(tmp_path)
    assert loaded.saves[0].conditions[0].params == leaf().params
    assert loaded.saves[1].conditions[0].params.lookback == 60
    assert loaded.saves[1].conditions[0].params.min_eok == 3
