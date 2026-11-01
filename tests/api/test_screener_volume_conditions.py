"""Volume thresholds, independent offsets, prior-only averages and exact v2 share units."""
import datetime as dt
import operator
from dataclasses import replace
from fractions import Fraction

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import (
    screener_bar_policy,
    screener_bar_volume as bars,
    screener_exclusions,
    screener_history_coverage,
    screener_recovery_compare,
    screener_scan,
    screener_series_eval,
    screener_series_store as store,
    screener_series_values,
    screener_volume_conditions as volumes,
)
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerSaveWriteRequest, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.util.timeenc import KST
from tests.api.test_screener_bar_threshold import candle, record, seed_threshold_corpus, stamp

KINDS = ['volume_range', 'volume_compare', 'volume_ratio']
CLOCK = dt.datetime(2026, 7, 28, 23, tzinfo=KST)


def leaf(kind='volume_range', **params):
    base = kind.removesuffix('_period')
    defaults = dict(offset=0, min_volume=100) if base == 'volume_range' else (
        dict(left_offset=0, right_offset=1, relation='gt') if base == 'volume_compare'
        else dict(offset=0, period=2, op='gte', pct=200))
    if kind.endswith('_period') and 'mode' not in params:
        defaults['lookback'] = 2
    return TypeAdapter(ConditionLeaf).validate_python(dict(id=kind, type=kind, params=defaults | params))


def candles(numbers):
    return [candle(volume=n, start_ms=stamp() + i * 300_000) for i, n in enumerate(numbers)]


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    return seed_threshold_corpus(tmp_path, monkeypatch)


@pytest.mark.parametrize('kind', [k + suffix for k in KINDS for suffix in ['', '_period']])
@pytest.mark.parametrize('timeframe', ['1m', '3m', '5m', '10m', '15m', '30m', '60m', 'D', 'W', 'M'])
def test_wire_roundtrip_and_bar_only_routing(kind, timeframe):
    condition = leaf(kind, timeframe=timeframe)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    assert bars.leaves([condition]) == [condition]
    save = ScreenerSaveWriteRequest(name='거래량', conditions=[condition])
    assert ScreenerSaveWriteRequest.model_validate_json(save.model_dump_json()) == save


@pytest.mark.parametrize('params', [dict(min_volume=100), dict(min_volume=None, max_volume=100),
                                   dict(min_volume=100, max_volume=100)])
def test_range_is_inclusive_and_counts_each_bar_not_interval_sum(params):
    condition = leaf('volume_range_period', lookback=3, **params)
    events, complete = record(condition, candles([100, 100, 100]))
    assert complete and len(events) == 3
    assert all(e.bar_volume_condition_match.left.value == '100' for e in events)
    assert record(leaf('volume_range_period', min_volume=200), candles([100, 100])) == ([], True)
    assert record(leaf(min_volume=0, max_volume=0), candles([0]))[0]


@pytest.mark.parametrize('relation, compare', [('gt', operator.gt), ('gte', operator.ge), ('lt', operator.lt),
                                            ('lte', operator.le), ('eq', operator.eq)])
@pytest.mark.parametrize('a,b', [(0, 0), (200, 100), (100, 200), (2**54 + 1, 2**54)])
def test_relations_preserve_integer_precision_and_zero(relation, compare, a, b):
    events, complete = record(leaf('volume_compare', relation=relation), candles([b, a]))
    assert complete and bool(events) == compare(a, b)
    if events:
        match = events[0].bar_volume_condition_match
        assert match.left.value == str(a) and match.right.value == str(b)


def test_independent_offsets_move_relative_to_each_candidate():
    data = candles([100, 200, 150, 500])
    events, complete = record(leaf('volume_compare_period', left_offset=1, right_offset=2), data)
    assert complete and [e.bar_start_ms for e in events] == [data[2].start_ms]
    match = events[0].bar_volume_condition_match
    assert (match.left.value, match.right.value) == ('200', '100')
    assert match.left.bar_start_ms == data[1].start_ms


@pytest.mark.parametrize('numbers,expected', [([100, 100, 200], 200), ([100, 100, 50], 50),
                                            ([100, 100, 100], 100), ([100, 100, 0], 0)])
@pytest.mark.parametrize('op', ['gte', 'lte', 'between'])
def test_ratio_excludes_target_and_uses_inclusive_zero_based_scale(numbers, expected, op):
    params = dict(op=op, **(dict(lo=expected, hi=expected) if op == 'between' else dict(pct=expected)))
    events, complete = record(leaf('volume_ratio', **params), candles(numbers))
    assert complete and len(events) == 1
    m = events[0].bar_volume_condition_match
    assert m.average == '100' and m.ratio_pct == expected
    assert m.window_end_ms < m.left.bar_start_ms


def test_ratio_offset_and_exact_fractional_threshold():
    data = candles([1, 3, 1, 20])
    m = record(leaf('volume_ratio', offset=1, pct=50), data)[0][0].bar_volume_condition_match
    assert m.left.value == '1' and m.average == '2' and m.ratio_pct == 50
    data = candles([Fraction(1, 3), Fraction(2, 3), Fraction(1, 2)])
    m = record(leaf('volume_ratio', pct=100), data)[0][0].bar_volume_condition_match
    assert m.average == '1/2' and m.ratio_pct == 100
    assert not record(leaf('volume_ratio', pct=100.000000001), data)[0]


@pytest.mark.parametrize('kind', KINDS)
def test_missing_invalid_and_live_rows_do_not_shift_positions(kind):
    condition = leaf(kind)
    data = candles([100, 100, 300])
    assert record(condition, [replace(data[-1], valid=False)]) == ([], False)
    assert record(condition, [replace(data[-1], volume=-1)]) == ([], False)
    assert record(condition, [replace(data[-1], volume=float('nan'))]) == ([], False)
    if kind != 'volume_range':
        assert record(condition, [data[-1]]) == ([], False)
        assert record(condition, [data[0], replace(data[1], valid=False), data[2]]) == ([], False)
    live = [*data[:-1], replace(data[-1], is_open=True)]
    events, complete = record(condition, live)
    assert complete and events[0].bar_volume_condition_match.left.is_open
    closed = record(leaf(kind, include_open_bar=False), live)[0]
    if kind == 'volume_range':
        assert closed[0].bar_start_ms == data[1].start_ms
        assert not closed[0].bar_volume_condition_match.left.is_open
    else:
        assert not closed


def test_zero_average_is_unknown_and_range_partial_history_still_preserves_confirmed_hit():
    assert volumes.evaluate(leaf('volume_ratio'), candles([0, 0, 500]), fetched_at_ms=1) == (
        [], False, 'zero_average_volume')
    events, complete = record(leaf('volume_range_period', lookback=20), candles([100]))
    assert events and not complete


@pytest.mark.parametrize('kind,params', [
    ('volume_range', dict(min_volume=None, max_volume=None)), ('volume_range', dict(max_volume=99)),
    ('volume_range', dict(min_volume=-1)), ('volume_range', dict(min_volume=1.5)),
    ('volume_range', dict(min_volume=True)), ('volume_range', dict(min_volume=2**53)),
    ('volume_compare', dict(left_offset=-1)), ('volume_compare', dict(right_offset=1001)),
    ('volume_compare', dict(left_offset=1.5)), ('volume_compare', dict(relation='cross')),
    ('volume_ratio', dict(period=0)), ('volume_ratio', dict(period=1001)), ('volume_ratio', dict(period=True)),
    ('volume_ratio', dict(offset=1001)), ('volume_ratio', dict(pct=float('inf'))),
    ('volume_ratio', dict(pct=-1)), ('volume_ratio', dict(op='between', lo=200, hi=100)),
    ('volume_ratio', dict(op='between', lo=1)), ('volume_ratio', dict(pct=None)),
    ('volume_range_period', dict(lookback=0)), ('volume_compare_period', dict(lookback=1.5)),
    ('volume_ratio_period', dict(mode='date_range', start_date='2026-07-28', end_date='2026-07-20')),
])
def test_invalid_parameters_rejected(kind, params):
    with pytest.raises(ValidationError):
        leaf(kind, **params)


@pytest.mark.parametrize('kind', KINDS)
async def test_dates_keep_prestart_average_and_do_not_enter_legacy_history_jobs(corpus, kind):
    condition = leaf(kind + '_period', mode='date_range', start_date='2026-07-28', end_date='2026-07-28',
                     **(dict(pct=50) if kind == 'volume_ratio' else {}))
    assert not screener_history_coverage.history_leaves([condition])
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=['005930'], basis='eod', now=CLOCK)
    assert [e.date for _, e in result.events[condition.id]] == ['2026-07-28']
    if kind == 'volume_ratio':
        assert result.events[condition.id][0][1].bar_volume_condition_match.average == '5500000'


@pytest.mark.parametrize('timeframe', ['W', 'M'])
async def test_date_end_prevents_later_volume_entering_aggregate(corpus, timeframe):
    condition = leaf('volume_range_period', timeframe=timeframe, min_volume=4_000_000,
                     mode='date_range', start_date='2026-07-01', end_date='2026-07-20')
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=['005930'], basis='eod', now=CLOCK)
    assert not result.events[condition.id]  # July 21's 9M cannot enter the week/month total.


def share_series(numbers, event=None):
    days = [dt.date(2026, 7, day) for day in (20, 21, 27, 28)]
    rows = {day: dict(open=100, high=100, low=100, close=100, volume=n)
            for day, n in zip(days, numbers, strict=True)}
    evidence = store.ShareEvidence(code='005930', instrument_id='test', verified_from=days[0], verified_to=days[-1],
        observed_at=CLOCK, source='test', events=[event] if event else [])
    return days, screener_series_values.Series(rows, {}, evidence, set())


def test_v2_uses_one_share_anchor_exactly_and_raw_is_independent_of_adjusted_prices():
    event = store.ShareEvent(effective_date=dt.date(2026, 7, 28), kind='consolidation',
                            numerator=1, denominator=3, source='test')
    days, series = share_series([1, 2, 1, 1], event)
    condition = leaf('volume_ratio', volume_basis='share_adjusted', pct=200)
    events, failures = screener_series_eval.evaluate_leaf(condition, '005930', series, days, CLOCK)
    assert not failures and events[0].bar_volume_condition_match.average == '1/2'
    assert events[0].bar_volume_condition_match.basis == 'share_adjusted'
    series.evidence = None
    assert screener_series_eval.evaluate_leaf(condition, '005930', series, days, CLOCK)[1][0].reason == \
        'share_evidence_unavailable'
    raw = leaf('volume_ratio', volume_basis='raw', pct=50)
    assert screener_series_eval.evaluate_leaf(raw, '005930', series, days, CLOCK)[0]
    series.conflicts.add(days[-2])
    assert screener_series_eval.evaluate_leaf(raw, '005930', series, days, CLOCK)[1][0].reason == \
        'original_observation_conflict'


@pytest.mark.parametrize('kind', KINDS)
@pytest.mark.parametrize('mode', ['latest', 'recent', 'date_range'])
async def test_v2_real_runner_matches_legacy_without_rounding(corpus, kind, mode):
    data = pl.read_parquet(corpus / 'screener/daily_unadjusted.parquet')
    for code in data['code'].unique():
        rows = [{**row, 'date': row['date'].isoformat()} for row in data.filter(pl.col('code') == code).to_dicts()]
        store.publish_pair(corpus, code, rows, rows, adjusted_as_of='2026-07-28',
                           price_events=[], observed_at=CLOCK.isoformat())
    base = dict(pct=50) if kind == 'volume_ratio' else {}
    if mode != 'latest':
        kind += '_period'
        base.update(dict(lookback=2) if mode == 'recent' else dict(
            mode='date_range', start_date='2026-07-27', end_date='2026-07-28'))
    old = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[leaf(kind, **base)]), now=CLOCK)
    new = await run_screener_scan(data_dir=corpus, req=ScanRequest(calculation_policy='separate_bases_v2',
        conditions=[leaf(kind, volume_basis='raw', **base)]), now=CLOCK)
    assert {row.code for row in old.rows} == {row.code for row in new.rows} == {'005930', '000660'}
    assert new.bar_coverage.complete == old.bar_coverage.complete == 2
    assert new.rows[0].occurrences[0].bar_volume_condition_match.basis == 'raw'
    assert [(e.date, e.bar_volume_condition_match.left.value) for e in new.rows[0].occurrences] == \
        [(e.date, e.bar_volume_condition_match.left.value) for e in old.rows[0].occurrences]


def test_v2_reports_zero_average_and_raw_quality_without_price_dependency():
    days, series = share_series([0, 0, 0, 1])
    condition = leaf('volume_ratio', volume_basis='raw')
    assert screener_series_eval.evaluate_leaf(condition, '005930', series, days, CLOCK)[1][0].reason == \
        'zero_average_volume'
    series.daily_quality[days[-2]] = 'daily_observation_unconfirmed'
    assert screener_series_eval.evaluate_leaf(condition, '005930', series, days, CLOCK)[1][0].reason == \
        'daily_observation_unconfirmed'


async def test_minute_volume_never_uses_price_factors(corpus, monkeypatch):
    data = candles([100, 100, 300])

    async def snapshot(*args, **kwargs):
        return bars.MinuteSnapshot(data, 123)

    async def forbidden(*args, **kwargs):
        raise AssertionError('volume cannot request price adjustment')

    monkeypatch.setattr(bars, 'minute_snapshot', snapshot)
    monkeypatch.setattr(bars.screener_bar_threshold, 'prepare_minutes', forbidden)
    result = await bars.evaluate(data_dir=corpus, conditions=[leaf('volume_ratio', timeframe='5m')],
                                 codes=['005930'], basis='intraday', now=CLOCK)
    match = result.events['volume_ratio'][0][1].bar_volume_condition_match
    assert match.left.value == '300' and match.average == '100' and match.basis == 'raw'


async def test_http_all_families_and_per_bar_exclusions_preserve_other_hits(corpus):
    conditions = [leaf('volume_range_period', lookback=3), leaf('volume_compare'), leaf('volume_ratio', pct=50)]
    app = FastAPI()

    @app.post('/scan', response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=CLOCK)

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        payload = dict(conditions=[c.model_dump() for c in conditions], limit=1)
        response = await client.post('/scan', json=payload)
        assert response.status_code == 200
        row = response.json()['rows'][0]
        assert {e['bar_volume_condition_match']['kind'] for e in row['occurrences']} == {'range', 'compare', 'ratio'}
        events = [e for e in row['occurrences'] if e['condition_id'] == conditions[0].id]
        for index, event in enumerate(events):
            response = await client.put('/exclusions', json=dict(condition=conditions[0].model_dump(), code=row['code'],
                stock_name=row['name'], date=event['date'], bar_start_ms=event['bar_start_ms']))
            assert response.status_code == 200
            after = (await client.post('/scan', json=payload)).json()['rows'][0]
            assert (after['code'] == row['code']) == (index + 1 < len(events))


@pytest.mark.parametrize('kind', KINDS)
def test_exclusion_identity_and_sql_boundary(corpus, kind):
    recent = leaf(kind + '_period', lookback=20)
    historical = leaf(kind + '_period', mode='date_range', start_date='2026-07-20', end_date='2026-07-28')
    assert screener_exclusions.condition_key(recent) == screener_exclusions.condition_key(historical)
    implicit = leaf(kind)
    explicit = leaf(kind, volume_basis='raw')
    assert screener_exclusions.condition_key(implicit, calculation_policy='separate_bases_v2') != \
        screener_exclusions.condition_key(explicit, calculation_policy='separate_bases_v2')
    with pytest.raises(ValueError, match='봉 이력 평가'):
        screener_scan.run_scan(corpus / 'screener/daily_adjusted.parquet', corpus / 'screener/stocks.parquet',
                              conditions=[recent], universe=ScreenerUniverse())


def test_history_requirement_and_policy_validation():
    assert screener_bar_policy.comparison_period(leaf('volume_range', offset=1000)) == 1001
    assert screener_bar_policy.comparison_period(leaf('volume_compare', right_offset=1000)) == 1001
    assert screener_bar_policy.comparison_period(leaf('volume_ratio', offset=1000, period=1000)) == 2001
    for condition in [leaf(volume_basis='raw'), leaf('volume_ratio', volume_basis='share_adjusted', timeframe='5m')]:
        with pytest.raises(ValidationError):
            ScanRequest(conditions=[condition])
    with pytest.raises(ValidationError):
        ScanRequest(calculation_policy='separate_bases_v2',
                    conditions=[leaf(volume_basis='share_adjusted', timeframe='5m')])


async def test_recovery_receipt_time_normalization_keeps_actual_quantity_changes(corpus):
    result = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[leaf()]), now=CLOCK)
    changed = result.model_copy(deep=True)
    match = changed.rows[0].occurrences[0].bar_volume_condition_match
    match.fetched_at_ms += 100
    assert screener_recovery_compare._stable(changed) == screener_recovery_compare._stable(result)
    match.left.value = '1'
    assert screener_recovery_compare._stable(changed) != screener_recovery_compare._stable(result)
