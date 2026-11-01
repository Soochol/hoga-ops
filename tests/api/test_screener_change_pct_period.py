"""Period change means individual historical candles, never interval returns."""
import datetime as dt
from dataclasses import replace

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import (
    screener_bar_policy,
    screener_bar_volume as bars,
    screener_exclusions,
    screener_history_coverage,
    screener_series_eval,
    screener_series_values,
)
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerSaveWriteRequest
from hoga.api.screener_runner import run_screener_scan
from hoga.util.timeenc import KST
from tests.api.test_screener_bar_threshold import candle, record, seed_threshold_corpus, stamp


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    return seed_threshold_corpus(tmp_path, monkeypatch)


def leaf(**params):
    return TypeAdapter(ConditionLeaf).validate_python({"id": "period", "type": "change_pct_period",
        "params": {"op": "gte", "pct": 10, **({} if "mode" in params else {"lookback": 2}), **params}})


@pytest.mark.parametrize("timeframe", ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "D", "W", "M"])
@pytest.mark.parametrize("historical", [False, True])
def test_roundtrip_and_candle_routing(timeframe, historical):
    params = {"mode": "date_range", "start_date": "2026-07-20", "end_date": "2026-07-28"} if historical else {}
    condition = leaf(timeframe=timeframe, **params)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    assert bars.leaves([condition]) == [condition]
    assert screener_history_coverage.history_leaves([condition]) == []
    save = ScreenerSaveWriteRequest(name="기간내 등락률", conditions=[condition])
    assert ScreenerSaveWriteRequest.model_validate_json(save.model_dump_json()) == save


@pytest.mark.parametrize("params", [
    {"lookback": 0}, {"lookback": 1001}, {"lookback": 1.5}, {"lookback": True},
    {"pct": float("nan")}, {"pct": float("inf")}, {"op": "between", "lo": 5, "hi": 2},
    {"timeframe": "2m"}, {"change_reference": "unknown"},
    {"mode": "date_range", "start_date": "2026-07-28", "end_date": "2026-07-20"},
    {"mode": "date_range", "start_date": "2026-02-30", "end_date": "2026-07-20"},
    {"mode": "date_range", "start_date": "2026-07-20", "end_date": "2999-01-01"},
    {"mode": "date_range", "start_date": "2026-07-20"},
])
def test_invalid_periods_and_thresholds_rejected(params):
    with pytest.raises(ValidationError):
        leaf(**params)


def test_each_candle_uses_its_own_reference_and_window_boundary():
    data = [candle(price, start_ms=stamp() + i * 300_000) for i, price in enumerate([100, 120, 120, 100])]
    condition = leaf(timeframe="5m", change_reference="previous_bar", lookback=3)
    events, complete = record(condition, data)
    assert complete and [e.bar_start_ms for e in events] == [data[1].start_ms]
    assert events[0].bar_change_match.reference_close == 100
    assert events[0].bar_change_match.change_pct == 20
    assert record(leaf(timeframe="5m", change_reference="previous_bar", lookback=2), data) == ([], True)
    # Overall return is zero; the individual +20% candle still matches.
    events, complete = record(leaf(timeframe="5m", change_reference="previous_bar", op="lte", pct=-10), data)
    assert complete and events[0].bar_start_ms == data[-1].start_ms


@pytest.mark.parametrize("reference", ["previous_day", "previous_bar", "bar_open"])
@pytest.mark.parametrize("op, bounds", [("gte", {"pct": 10}), ("lte", {"pct": 10}),
                                       ("between", {"lo": 10, "hi": 10})])
def test_references_operators_and_equal_boundaries(reference, op, bounds):
    data = [candle(100), replace(candle(110, start_ms=stamp() + 300_000), open=100, low=100,
                               previous_day_close=100, previous_day_ms=stamp("2026-07-29"))]
    events, complete = record(leaf(lookback=1, change_reference=reference, op=op, **bounds), data)
    assert complete and events[0].bar_change_match.change_pct == 10


def test_partial_missing_and_live_candles_are_not_complete_no_matches():
    data = [replace(candle(110), open=100, low=100)]
    events, complete = record(leaf(change_reference="bar_open"), data)
    assert len(events) == 1 and not complete
    assert record(leaf(lookback=1), data) == ([], False)
    assert record(leaf(lookback=1), [replace(data[0], previous_day_close=0, previous_day_ms=1)]) == ([], False)
    assert record(leaf(lookback=1), [replace(data[0], valid=False)]) == ([], False)
    live = replace(data[0], is_open=True)
    condition = leaf(lookback=1, change_reference="bar_open")
    assert record(condition, [live])[0][0].bar_change_match.is_open
    assert record(condition, [replace(live, close=100)])[0] == []
    assert record(leaf(lookback=1, change_reference="bar_open", include_open_bar=False), [live]) == ([], False)


def test_dates_select_candidates_but_keep_previous_bar_outside_range():
    data = [candle(price, start_ms=stamp(day)) for price, day in
            [(100, "2026-07-20"), (110, "2026-07-21"), (150, "2026-07-22")]]
    condition = leaf(mode="date_range", start_date="2026-07-21", end_date="2026-07-21",
                     change_reference="previous_bar")
    events, complete = record(condition, data)
    assert complete and [e.date for e in events] == ["2026-07-21"]
    assert events[0].bar_change_match.reference_close == 100
    assert record(condition, [data[0]]) == ([], False)
    assert screener_exclusions.condition_key(condition) == screener_exclusions.condition_key(
        leaf(change_reference="previous_bar", lookback=100))


async def test_calendar_period_and_date_cutoff_do_not_use_later_values(corpus):
    args = dict(data_dir=corpus, codes=["005930"], basis="eod", now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    result = await bars.evaluate(**args, conditions=[leaf(lookback=3)])
    assert [event.date for _, event in result.events["period"]] == ["2026-07-21", "2026-07-28"]
    assert result.coverage.complete == 1
    condition = leaf(mode="date_range", start_date="2026-07-20", end_date="2026-07-20",
                     timeframe="W", change_reference="bar_open", pct=50)
    result = await bars.evaluate(**args, conditions=[condition])
    assert result.events["period"] == []  # Tuesday's 200 must not enter Monday's weekly slice.
    assert not bars.needs_daily_overlay(condition, "2026-07-28")


async def test_http_occurrences_can_be_excluded_individually_before_limit(corpus):
    condition = leaf(lookback=3)
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        payload = {"conditions": [condition.model_dump()], "limit": 1}
        response = await client.post("/scan", json=payload)
        assert response.status_code == 200
        row = response.json()["rows"][0]
        assert len(row["occurrences"]) == 2
        for index, event in enumerate(row["occurrences"]):
            assert event["bar_change_match"]["change_reference"] == "previous_day"
            assert event["bar_change_match"]["reference_close"] > 0
            response = await client.put("/exclusions", json={"condition": condition.model_dump(),
                "code": row["code"], "stock_name": row["name"], "date": event["date"],
                "bar_start_ms": event["bar_start_ms"]})
            assert response.status_code == 200
            result = (await client.post("/scan", json=payload)).json()
            if index == 0:
                assert result["rows"][0]["code"] == row["code"]
                assert len(result["rows"][0]["occurrences"]) == 1
        assert result["rows"][0]["code"] != row["code"]


def test_period_always_requires_candle_evaluation():
    assert screener_bar_policy.needs_bars(leaf())


@pytest.mark.parametrize("reference", ["previous_day", "previous_bar", "bar_open"])
@pytest.mark.parametrize("historical", [False, True])
def test_v2_uses_each_candidates_own_comparison(reference, historical):
    days = [dt.date(2026, 7, day) for day in (20, 21, 22, 23)]
    prices = {day: {"open": 100, "high": price, "low": 100, "close": price}
              for day, price in zip(days, [100, 120, 120, 120], strict=True)}
    series = screener_series_values.Series({}, prices, None, set())
    params = {"mode": "date_range", "start_date": "2026-07-21", "end_date": "2026-07-23"} if historical else {
        "lookback": 3}
    condition = leaf(change_reference=reference, **params)
    events, failures = screener_series_eval.evaluate_leaf(condition, "005930", series, days,
        dt.datetime(2026, 7, 23, 23, tzinfo=KST))
    assert not failures
    assert [event.date for event in events] == (["2026-07-21", "2026-07-22", "2026-07-23"]
                                               if reference == "bar_open" else ["2026-07-21"])


async def test_minute_period_uses_previous_day_reference_for_each_candidate(corpus, monkeypatch):
    data = [candle(220, start_ms=stamp("2026-07-27")), candle(121, start_ms=stamp("2026-07-28"))]

    async def snapshot(*args, **kwargs):
        return bars.MinuteSnapshot(data, 123)

    async def adjusted(data_dir, code, rows, anchor):
        return rows, None

    monkeypatch.setattr(bars, "minute_snapshot", snapshot)
    monkeypatch.setattr(bars.screener_bar_price, "adjusted_minutes", adjusted)
    result = await bars.evaluate(data_dir=corpus, codes=["005930"], conditions=[leaf(timeframe="5m")],
        basis="intraday", now=dt.datetime(2026, 7, 28, 11, tzinfo=KST))
    events = [event for _, event in result.events["period"]]
    assert result.coverage.complete == 1
    assert [event.bar_change_match.reference_close for event in events] == [200, 110]
    assert [event.bar_change_match.change_pct for event in events] == [10, 10]


async def test_http_date_range_is_evaluated_without_legacy_collection(corpus):
    req = ScanRequest(conditions=[leaf(mode="date_range", start_date="2026-07-21", end_date="2026-07-21")])
    result = await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    assert len(result.rows) == 2
    assert [event.date for event in result.rows[0].occurrences] == ["2026-07-21"]
