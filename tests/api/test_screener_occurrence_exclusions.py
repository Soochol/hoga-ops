"""Exclusions preserve independent dates/conditions and precede AND/limit."""
from __future__ import annotations

import datetime as dt

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter

from hoga.api import screener_exclusions as exclusions, screener_history_coverage as history, screener_scan
from hoga.api.models import ConditionLeaf, ScreenerUniverse
from hoga.api.screener_depth import _period_occurrences


def leaf(id="v", type="trade_value_period", **params):
    return TypeAdapter(ConditionLeaf).validate_python(
        dict(id=id, type=type, params=params or {"lookback": 3, "min_eok": 1}))


@pytest.fixture
def corpus(tmp_path):
    rows = [dict(code=code, date=dt.date(2026, 9, day), open=price, high=price,
                 low=price, close=price, volume=2_000_000)
            for code, price in [("005930", 100), ("000660", 70)] for day in (7, 8, 9)]
    pl.DataFrame(rows).write_parquet(tmp_path / "daily.parquet")
    pl.DataFrame([dict(code=code, name=code, market="KOSPI", is_etf=False, is_halted=False)
                  for code in ("005930", "000660")]).write_parquet(tmp_path / "stocks.parquet")
    return tmp_path


def scan(corpus, conditions, excluded=(), limit=1000, **kwargs):
    return screener_scan.run_scan(corpus / "daily.parquet", corpus / "stocks.parquet",
        conditions=conditions, universe=ScreenerUniverse(), excluded=set(excluded), limit=limit, **kwargs)


def test_excluding_latest_preserves_prior_and_other_condition(corpus):
    value, high = leaf(), leaf("h", "new_high", lookback=3, period=2)
    key = exclusions.condition_key(value)
    rows = scan(corpus, [value, high], [(key, "005930", "2026-09-09")])
    samsung = next(r for r in rows if r.code == "005930")
    assert [(o.condition_id, o.date) for o in samsung.occurrences] == [
        ("v", "2026-09-08"), ("v", "2026-09-07"), ("h", "2026-09-09"), ("h", "2026-09-08")]


def test_all_dates_of_one_condition_remove_stock_before_limit(corpus):
    value, high = leaf(), leaf("h", "new_high", lookback=3, period=2)
    key = exclusions.condition_key(value)
    removed = [(key, "005930", f"2026-09-0{day}") for day in (7, 8, 9)]
    assert [r.code for r in scan(corpus, [value, high], removed, limit=1)] == ["000660"]
    assert [r.code for r in scan(corpus, [value, high], limit=1)] == ["005930"]


def test_identity_ignores_leaf_id_and_search_window_not_threshold():
    assert exclusions.condition_key(leaf()) == exclusions.condition_key(leaf("other", lookback=20, min_eok=1))
    assert exclusions.condition_key(leaf()) != exclusions.condition_key(leaf(min_eok=2, lookback=3))
    a = leaf(mode="date_range", start_date="2026-01-01", end_date="2026-09-01", min_eok=1)
    b = leaf(mode="date_range", start_date="2025-01-01", end_date="2026-09-09", min_eok=1)
    assert exclusions.condition_key(a) == exclusions.condition_key(b) == exclusions.condition_key(leaf())
    # Here lookback is the comparison baseline, so it MUST remain in the identity.
    a = leaf(type="ask_depth_new_high", lookback=3, threshold_pct=100)
    b = leaf(type="ask_depth_new_high", lookback=4, threshold_pct=100)
    assert exclusions.condition_key(a) != exclusions.condition_key(b)


async def test_http_persistence_idempotence_restore_and_validation(tmp_path):
    app = FastAPI()
    app.include_router(exclusions.build_router(tmp_path))
    body = {"condition": leaf().model_dump(), "code": "005930", "date": "2026-09-09", "stock_name": "삼성전자"}
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.put('/exclusions', json=body)
        assert response.status_code == 200
        item = response.json()
        assert item['condition_key'] == exclusions.condition_key(leaf())
        assert (await client.put('/exclusions', json=body)).json() == item
        assert (await client.get('/exclusions')).json()['exclusions'] == [item]
        assert len(exclusions.load_exclusions(tmp_path).exclusions) == 1
        assert (await client.put('/exclusions', json={**body, 'date': '2026-02-30'})).status_code == 422
        for _ in range(2):
            assert (await client.delete(f"/exclusions/{item['id']}")).status_code == 204
        assert exclusions.load_exclusions(tmp_path).exclusions == []


async def test_write_failure_does_not_claim_success(tmp_path, monkeypatch):
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(exclusions, 'atomic_write_json', fail)
    from hoga.api.models import ScreenerExclusionWrite
    with pytest.raises(OSError):
        await exclusions.put_exclusion(tmp_path, ScreenerExclusionWrite(condition=leaf(), code="005930",
            date=dt.date(2026, 9, 9), stock_name="삼성전자"))
    assert exclusions.load_exclusions(tmp_path).exclusions == []


def test_history_keeps_all_dates_and_applies_exclusions_before_join(corpus):
    condition = leaf(mode="date_range", start_date="2026-09-07", end_date="2026-09-09", min_eok=1)
    dates = [dt.date(2026, 9, d) for d in (7, 8, 9)]
    plan = history.plan_windows(condition, dates)
    matches = history.all_trade_value_matches(plan, dict.fromkeys(dates, 2e8), 1)
    assert [m.date for m in matches] == [d.isoformat() for d in dates]
    rows = scan(corpus, [condition], [(exclusions.condition_key(condition), "005930", "2026-09-09")],
        history_pass={"v": ["005930"]}, occurrence_dates={"v": {"005930": [m.date for m in matches]}})
    assert [o.date for o in rows[0].occurrences] == ["2026-09-08", "2026-09-07"]


def test_depth_period_exposes_each_actual_date():
    assert _period_occurrences({"005930": {"20260907": 100, "20260908": 200, "20260909": 300}},
        ["20260907", "20260908", "20260909"], lookback=3, period=1, threshold_pct=100) == {
            "005930": ["2026-09-08", "2026-09-09"]}


@pytest.mark.parametrize('type,params', [
    ('trade_value', {'min_eok': 1}), ('price_range', {'min': 1}),
    ('change_pct', {'op': 'gte', 'pct': 0}), ('ma', {'period': 2, 'relation': 'above'}),
    ('high_off_peak', {'period': 2, 'pct': 10, 'side': 'within'}),
    ('new_high_today', {'period': 2}), ('new_high_vol_today', {'period': 2}),
])
def test_current_conditions_use_actual_corpus_day(corpus, type, params):
    condition = leaf(type=type, **params)
    rows = scan(corpus, [condition])
    assert all([o.date for o in row.occurrences] == ['2026-09-09'] for row in rows)
    assert len(rows) == 2
    remaining = scan(corpus, [condition], [(exclusions.condition_key(condition), '005930', '2026-09-09')])
    assert [r.code for r in remaining] == ['000660']


async def test_real_scan_http_reloads_exclusions_and_restores_latest(corpus):
    from hoga.api.screener import build_router
    sdir = corpus / 'screener'
    sdir.mkdir()
    (sdir / 'daily_adjusted.parquet').write_bytes((corpus / 'daily.parquet').read_bytes())
    (sdir / 'stocks.parquet').write_bytes((corpus / 'stocks.parquet').read_bytes())
    (sdir / 'status.json').write_text('{}')
    app = FastAPI()
    app.include_router(build_router(data_dir=corpus))
    condition = leaf()
    request = {'conditions': [condition.model_dump()], 'limit': 1}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        before = (await client.post('/api/screener/scan', json=request)).json()
        assert before['rows'][0]['code'] == '005930'
        assert len(before['rows'][0]['occurrences']) == 3
        identities = []
        for day in (7, 8, 9):
            response = await client.put('/api/screener/exclusions', json={
                'condition': condition.model_dump(), 'code': '005930', 'stock_name': '삼성전자',
                'date': f'2026-09-0{day}',
            })
            identities.append(response.json()['id'])
        after = (await client.post('/api/screener/scan', json=request)).json()
        assert [row['code'] for row in after['rows']] == ['000660']
        assert after['has_more'] is False
        await client.delete(f'/api/screener/exclusions/{identities[-1]}')
        # New leaf ID still means the same predicate, including persisted exclusions.
        request['conditions'][0]['id'] = 'new-leaf-id'
        restored = (await client.post('/api/screener/scan', json=request)).json()
        assert restored['rows'][0]['code'] == '005930'
        assert [o['date'] for o in restored['rows'][0]['occurrences']] == ['2026-09-09']
        assert restored['has_more'] is True


async def test_history_volume_runner_keeps_earlier_evidence(corpus, monkeypatch):
    from hoga.api.models import ScanRequest, ScreenerExclusionWrite
    from hoga.api.screener_runner import run_screener_scan
    sdir = corpus / 'screener'
    sdir.mkdir()
    (sdir / 'daily_adjusted.parquet').write_bytes((corpus / 'daily.parquet').read_bytes())
    (sdir / 'stocks.parquet').write_bytes((corpus / 'stocks.parquet').read_bytes())
    (sdir / 'status.json').write_text('{}')
    pl.DataFrame(dict(code=['005930', '000660'], seg_start=[dt.date(2026, 9, 7)] * 2,
                      factor=[1., 1.])).write_parquet(sdir / 'factors.parquet')
    monkeypatch.setattr(history.trading_days, 'trading_days', lambda _: ['20260907', '20260908', '20260909'])
    condition = leaf(type='new_high_vol', mode='date_range', start_date='2026-09-07',
                     end_date='2026-09-09', record_period={'unit': 'trading_days', 'value': 1})
    await exclusions.put_exclusion(corpus, ScreenerExclusionWrite(condition=condition,
        code='005930', date=dt.date(2026, 9, 9), stock_name='삼성전자'))
    result = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[condition]))
    row = next(row for row in result.rows if row.code == '005930')
    assert [o.date for o in row.occurrences] == ['2026-09-08', '2026-09-07']
    assert row.history_matches[0].date == '2026-09-08'


def test_intraday_occurrence_uses_overlay_day_and_fallback_uses_corpus(corpus):
    condition = leaf(type='price_range', min=1)
    overlay = pl.DataFrame([dict(code='005930', date=dt.date(2026, 9, 10),
        open=100, high=100, low=100, close=100, volume=2_000_000)])
    rows = scan(corpus, [condition], intraday_rows=overlay)
    row = next(row for row in rows if row.code == '005930')
    assert [o.date for o in row.occurrences] == ['2026-09-10']
    remaining = scan(corpus, [condition],
        [(exclusions.condition_key(condition), '005930', '2026-09-10')], intraday_rows=overlay)
    assert [r.code for r in remaining] == ['000660']
    fallback = scan(corpus, [condition],
        [(exclusions.condition_key(condition), '005930', '2026-09-10')])
    assert next(r for r in fallback if r.code == '005930').occurrences[0].date == '2026-09-09'
