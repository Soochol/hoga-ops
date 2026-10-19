"""Candle-count records across minute/calendar periods and their HTTP contract."""
import datetime as dt
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import screener_bar_volume as bars, screener_exclusions, screener_history_coverage, screener_scan
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.util.timeenc import KST


def leaf(**params):
    return TypeAdapter(ConditionLeaf).validate_python({"id": "v", "type": "new_high_vol", "params": params})


def stamp(day="2026-07-30", clock="10:00"):
    return int(dt.datetime.fromisoformat(day + "T" + clock).replace(tzinfo=KST).timestamp() * 1000)


def series(volumes, **kwargs):
    return [bars.VolumeBar(stamp() + i * 300_000, volume, **kwargs) for i, volume in enumerate(volumes)]


def test_old_conditions_default_to_daily_and_keep_exclusion_identity():
    old = leaf(lookback=60, period=250)
    explicit = leaf(lookback=60, period=250, timeframe="D", include_open_bar=True)
    assert old.params.timeframe == "D" and old.params.include_open_bar
    assert bars.leaves([old]) == []
    assert screener_exclusions.condition_key(old) == screener_exclusions.condition_key(explicit)
    assert screener_exclusions.condition_key(old) != screener_exclusions.condition_key(
        leaf(lookback=60, period=250, timeframe="W"))
    with pytest.raises(ValidationError):
        leaf(lookback=2, period=3, timeframe="2m")


def test_inclusive_window_ties_zero_volume_and_full_history():
    condition = leaf(lookback=3, period=3, timeframe="5m")
    events, complete = bars.records(condition, series([10, 20, 20, 5, 30]), fetched_at_ms=123)
    assert complete
    assert [event.bar_start_ms for event in events] == [stamp() + 600_000, stamp() + 1_200_000]
    assert events[-1].bar_match.window_start_ms == stamp() + 600_000
    assert bars.records(condition, series([0, 0, 0]), fetched_at_ms=0)[0] == []
    assert not bars.records(condition, series([10, 20]), fetched_at_ms=0)[1]


def test_records_use_each_candidates_history_not_future_peaks():
    condition = leaf(timeframe="5m", lookback=3, period=3)
    original = series([10, 20, 30, 5, 1000])
    events, _ = bars.records(condition, original, fetched_at_ms=0)
    assert events[0].bar_start_ms == original[2].start_ms
    assert events[0].bar_match.maximum == 30


def test_live_candle_crossing_and_complete_only_shift_the_lookback():
    condition = leaf(timeframe="5m", lookback=1, period=3)
    history = series([10, 20, 15])
    live = bars.VolumeBar(stamp() + 900_000, 19, is_open=True)
    assert bars.records(condition, history + [live], fetched_at_ms=1)[0] == []
    live = bars.VolumeBar(live.start_ms, 21, is_open=True)
    events, _ = bars.records(condition, history + [live], fetched_at_ms=2)
    assert events[0].bar_match.is_open and events[0].bar_match.volume == 21
    closed = leaf(timeframe="5m", lookback=1, period=3, include_open_bar=False)
    assert bars.records(closed, history + [live], fetched_at_ms=2)[0] == []


def test_missing_bar_invalidates_only_windows_that_depend_on_it():
    condition = leaf(timeframe="5m", lookback=3, period=2)
    data = series([10, 20, 30, 40])
    data[1] = bars.VolumeBar(data[1].start_ms, 20, valid=False)
    events, complete = bars.records(condition, data, fetched_at_ms=0)
    assert not complete
    assert [event.bar_start_ms for event in events] == [data[3].start_ms]


@pytest.mark.parametrize("timeframe, dates, volumes, expected", [
    ("W", ["2026-07-20", "2026-07-21", "2026-07-27", "2026-07-28"], [10, 20, 15, 20], [30, 35]),
    ("M", ["2026-06-01", "2026-06-02", "2026-07-01", "2026-07-02"], [10, 20, 15, 20], [30, 35]),
])
def test_week_month_aggregate_real_calendar_periods(timeframe, dates, volumes, expected):
    days = list(map(dt.date.fromisoformat, dates))
    as_of = dt.datetime(2026, 7, 30, 10, tzinfo=KST)
    grouped = bars.calendar_bars(dict(zip(days, volumes, strict=True)), days, timeframe=timeframe, as_of=as_of)
    assert [bar.volume for bar in grouped] == expected
    assert grouped[-1].is_open
    assert not grouped[0].is_open
    assert grouped[0].start_ms == stamp(dates[0], "09:00")
    values = dict(zip(days, volumes, strict=True))
    del values[days[-1]]
    assert not bars.calendar_bars(values, days, timeframe=timeframe, as_of=as_of)[-1].valid


def test_friday_close_completes_week_even_if_calendar_stops_on_friday():
    day = dt.date(2026, 7, 31)
    grouped = bars.calendar_bars({day: 10}, [day], timeframe="W",
                               as_of=dt.datetime(2026, 7, 31, 15, 31, tzinfo=KST))
    assert not grouped[0].is_open


def test_date_range_has_bar_comparison_and_excludes_future_data():
    condition = leaf(mode="date_range", timeframe="5m", start_date="2026-07-30", end_date="2026-07-30",
                     record_period={"unit": "bars", "value": 3})
    assert screener_history_coverage.history_leaves([condition]) == []
    data = series([10, 20, 30]) + [bars.VolumeBar(stamp("2026-07-31"), 9999)]
    events, complete = bars.records(condition, data, fetched_at_ms=0)
    assert not complete and len(events) == 1 and events[0].bar_match.maximum == 30
    recent = leaf(timeframe="5m", lookback=60, period=3)
    assert screener_exclusions.condition_key(condition) == screener_exclusions.condition_key(recent)


@pytest.fixture
def corpus(tmp_path):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / "status.json").write_text('{}')
    pl.DataFrame([{"code": code, "date": dt.date(2026, 7, day), "open": 100.0, "high": 100.0,
                   "low": 100.0, "close": 100.0, "volume": vol}
                  for code, vol in [("005930", 100), ("000660", 50)] for day in (20, 21, 27, 28)]
                 ).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame([{"code": code, "name": code, "market": "KOSPI", "is_etf": False, "is_halted": False}
                  for code in ("005930", "000660")]).write_parquet(sdir / "stocks.parquet")
    return tmp_path


async def test_calendar_runner_http_serializes_evidence_and_coverage(corpus, monkeypatch):
    monkeypatch.setattr(bars.trading_days, 'trading_days', lambda _: {'20260720', '20260721', '20260727', '20260728'})
    app = FastAPI()

    @app.post('/scan', response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req,
                                      now=dt.datetime(2026, 7, 29, 10, tzinfo=KST))

    condition = leaf(timeframe="W", lookback=1, period=2)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/scan', json={"conditions": [condition.model_dump()], "basis": "eod"})
    assert response.status_code == 200
    result = response.json()
    assert result['bar_coverage']['total'] == 2
    event = result['rows'][0]['occurrences'][0]
    assert event['bar_start_ms'] == stamp('2026-07-27', '09:00')
    assert event['bar_match']['timeframe'] == 'W'
    assert event['bar_match']['is_open']


async def test_timestamp_exclusions_keep_sibling_bar_and_precede_limit(corpus):
    condition = leaf(timeframe="5m", lookback=2, period=2)
    events, _ = bars.records(condition, series([10, 20, 30]), fetched_at_ms=0)
    sdir = corpus / 'screener'
    kwargs = dict(conditions=[condition], universe=ScreenerUniverse(), limit=1,
                  bar_events={'v': [(code, event) for code in ('005930', '000660') for event in events]})
    key = screener_exclusions.condition_key(condition)
    out = screener_scan.run_scan(sdir / 'daily_adjusted.parquet', sdir / 'stocks.parquet',
        excluded={(key, '005930', '2026-07-30', events[0].bar_start_ms)}, **kwargs)
    assert out[0].code == '005930'
    assert [event.bar_start_ms for event in out[0].occurrences] == [events[1].bar_start_ms]
    out = screener_scan.run_scan(sdir / 'daily_adjusted.parquet', sdir / 'stocks.parquet',
        excluded={(key, '005930', '2026-07-30', event.bar_start_ms) for event in events}, **kwargs)
    assert out[0].code == '000660'
    app = FastAPI()
    app.include_router(screener_exclusions.build_router(corpus))
    body = {"condition": condition.model_dump(), "code": "005930", "stock_name": "삼성전자",
            "date": "2026-07-30", "bar_start_ms": events[0].bar_start_ms}
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        a = (await client.put('/exclusions', json=body)).json()
        b = (await client.put('/exclusions', json={**body, 'bar_start_ms': events[1].bar_start_ms})).json()
        assert a['id'] != b['id']
        assert len((await client.get('/exclusions')).json()['exclusions']) == 2
        assert (await client.put('/exclusions', json={**body, 'date': '2026-07-29'})).status_code == 422


@pytest.fixture
def minute_vendor(monkeypatch):
    bars._CACHE.clear()
    bars._FLIGHTS.clear()
    bars._CURSORS.clear()
    calls = []
    rows = [{"cntr_tm": '20260730' + clock, 'trde_qty': str(volume),
             'cur_prc': '100', 'open_pric': '100', 'high_pric': '100', 'low_pric': '100'}
            for clock, volume in [('100000', 10), ('100500', 20), ('101000', 30)]]

    class Client:
        async def call(self, api_id, params):
            calls.append(params)
            return SimpleNamespace(rows=rows)

    monkeypatch.setattr(bars.kiwoom_rest_runtime, 'ensure_rest_client', lambda _: Client())
    monkeypatch.setattr(bars.kiwoom_rest_runtime, 'ensure_scheduler', lambda _: object())

    async def run(_, *, client, fetch_fn, **kwargs):
        return await fetch_fn(client)
    monkeypatch.setattr(bars.kiwoom_access, 'run_with_capacity', run)
    return calls, rows


async def test_minute_snapshot_live_volume_cache_and_granularity(tmp_path, minute_vendor):
    calls, rows = minute_vendor
    now = dt.datetime(2026, 7, 30, 10, 12, tzinfo=KST)
    one = await bars.minute_snapshot(tmp_path, '005930', '5m', 3, None, now)
    two = await bars.minute_snapshot(tmp_path, '005930', '5m', 3, None, now)
    assert one is two and len(calls) == 1
    assert calls[0]['tic_scope'] == '5' and calls[0]['upd_stkpc_tp'] == '0'
    assert one.bars[-1].volume == 30 and one.bars[-1].is_open
    rows[-1]['trde_qty'] = '45'
    bars._CACHE.clear()
    changed = await bars.minute_snapshot(tmp_path, '005930', '5m', 3, None, now)
    assert changed.bars[-1].volume == 45
    await bars.minute_snapshot(tmp_path, '005930', '1m', 3, None, now)
    assert calls[-1]['tic_scope'] == '1'


async def test_minute_budget_rotation_and_missing_credentials_are_explicit(tmp_path, minute_vendor, monkeypatch):
    monkeypatch.setattr(bars, 'MAX_MINUTE_CODES_PER_SCAN', 1)
    condition = leaf(timeframe='5m', lookback=1, period=3)
    args = dict(data_dir=tmp_path, conditions=[condition], codes=['005930', '000660'], basis='intraday',
                now=dt.datetime(2026, 7, 30, 10, 12, tzinfo=KST))
    first = await bars.evaluate(**args)
    assert first.coverage.complete == 1
    assert first.coverage.incomplete[0].reason == 'fetch_budget_exhausted'
    second = await bars.evaluate(**args)
    assert second.coverage.complete == 2
    bars._CACHE.clear()
    monkeypatch.setattr(bars.kiwoom_rest_runtime, 'ensure_rest_client', lambda _: None)
    result = await bars.evaluate(**args)
    assert result.coverage.complete == 0
    assert 'credentials_missing' in [item.reason for item in result.coverage.incomplete]


async def test_weekly_intraday_overlay_replaces_today_without_double_counting(corpus, monkeypatch):
    monkeypatch.setattr(bars.trading_days, 'trading_days', lambda _: {'20260720', '20260721', '20260727', '20260728'})
    condition = leaf(timeframe='W', lookback=1, period=2)
    overlay = pl.DataFrame({'code': ['005930'], 'date': [dt.date(2026, 7, 28)], 'volume': [1000]})
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=['005930'], basis='intraday',
        now=dt.datetime(2026, 7, 28, 10, tzinfo=KST), overlay=overlay)
    assert result.events['v'][0][1].bar_match.volume == 1100
    assert result.events['v'][0][1].bar_match.is_open
    eod = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=['005930'], basis='eod',
        now=dt.datetime(2026, 7, 28, 10, tzinfo=KST), overlay=overlay)
    assert eod.events['v'] == []


async def test_calendar_range_end_is_a_snapshot_cutoff_not_future_week_volume(corpus, monkeypatch):
    monkeypatch.setattr(bars.trading_days, 'trading_days', lambda _: {
        '20260720', '20260721', '20260727', '20260728', '20260729', '20260730'})
    path = corpus / 'screener/daily_adjusted.parquet'
    data = pl.read_parquet(path)
    extra = data.filter(pl.col('code') == '005930').tail(1).with_columns(
        pl.lit(dt.date(2026, 7, 29)).alias('date'), pl.lit(99999, dtype=pl.Int64).alias('volume'))
    pl.concat([data, extra]).write_parquet(path)
    condition = leaf(mode='date_range', timeframe='W', start_date='2026-07-27', end_date='2026-07-28',
                     record_period={'unit': 'bars', 'value': 2})
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=['005930'], basis='intraday',
                                now=dt.datetime(2026, 7, 30, 10, tzinfo=KST))
    assert result.events['v'][0][1].bar_match.volume == 200
    assert result.events['v'][0][1].bar_match.is_open
    assert not bars.needs_daily_overlay(condition, '2026-07-30')


async def test_unknown_calendar_tail_cannot_produce_a_false_week_record(corpus, monkeypatch):
    monkeypatch.setattr(bars.trading_days, 'trading_days', lambda _: {'20260720', '20260721', '20260727', '20260728'})
    result = await bars.evaluate(data_dir=corpus, conditions=[leaf(timeframe='W', lookback=1, period=2)],
        codes=['005930'], basis='intraday', now=dt.datetime(2026, 7, 30, 10, tzinfo=KST))
    assert result.events['v'] == []
    assert result.coverage.complete == 0


def test_scan_requires_the_selected_timeframes_evaluator(corpus):
    with pytest.raises(ValueError, match='봉 이력 평가'):
        screener_scan.run_scan(corpus / 'screener/daily_adjusted.parquet', corpus / 'screener/stocks.parquet',
            conditions=[leaf(timeframe='W', lookback=1, period=2)], universe=ScreenerUniverse())


async def test_invalid_minute_volume_is_not_silently_converted_to_zero(tmp_path, minute_vendor):
    _, rows = minute_vendor
    rows[0]['trde_qty'] = ''
    result = await bars.minute_snapshot(tmp_path, '005930', '5m', 3, None,
                                        dt.datetime(2026, 7, 30, 10, 12, tzinfo=KST))
    assert result.reason == 'invalid_rows' and result.bars == []


def test_single_bar_comparison_does_not_claim_the_whole_search_window_is_covered():
    condition = leaf(timeframe='5m', lookback=60, period=1)
    events, complete = bars.records(condition, series([10]), fetched_at_ms=0)
    assert len(events) == 1 and not complete
