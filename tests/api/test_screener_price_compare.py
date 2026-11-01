"""Two independently shifted OHLC operands, calendar/minute bases and wire evidence."""
import datetime as dt
import operator
from dataclasses import replace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import (
    screener_bar_price as prices,
    screener_bar_volume as bars,
    screener_exclusions,
    screener_history_coverage,
    screener_recovery_compare,
    screener_scan,
    screener_series_eval,
    screener_series_store,
    screener_series_values,
)
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerSaveWriteRequest, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.live.kiwoom_adjust_factors import AdjustFactors
from hoga.util.timeenc import KST
from tests.api.test_screener_bar_threshold import candle, record, seed_threshold_corpus, stamp


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    return seed_threshold_corpus(tmp_path, monkeypatch)


def leaf(kind="price_compare", **params):
    defaults = {"left": {"offset": 0, "source": "close"}, "right": {"offset": 1, "source": "high"},
                "relation": "gt"}
    if kind == "price_compare_period" and "mode" not in params:
        defaults["lookback"] = 2
    return TypeAdapter(ConditionLeaf).validate_python({"id": kind, "type": kind, "params": defaults | params})


@pytest.mark.parametrize("kind", ["price_compare", "price_compare_period"])
@pytest.mark.parametrize("timeframe", ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "D", "W", "M"])
def test_models_roundtrip_and_always_require_candle_evaluation(kind, timeframe):
    condition = leaf(kind, timeframe=timeframe)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    assert bars.leaves([condition]) == [condition]
    save = ScreenerSaveWriteRequest(name="주가 비교", conditions=[condition])
    assert ScreenerSaveWriteRequest.model_validate_json(save.model_dump_json()) == save


@pytest.mark.parametrize("source_a", ["open", "high", "low", "close"])
@pytest.mark.parametrize("source_b", ["open", "high", "low", "close"])
@pytest.mark.parametrize("relation, compare", [("gt", operator.gt), ("gte", operator.ge), ("lt", operator.lt),
                                            ("lte", operator.le), ("eq", operator.eq)])
def test_all_sources_and_relations_use_actual_operand_values(source_a, source_b, relation, compare):
    data = [replace(candle(110), open=100, high=120, low=90)]
    condition = leaf(left={"offset": 0, "source": source_a}, right={"offset": 0, "source": source_b},
                     relation=relation)
    events, complete = record(condition, data)
    assert complete and bool(events) == compare(getattr(data[0], source_a), getattr(data[0], source_b))
    if events:
        evidence = events[0].bar_price_compare_match
        assert evidence.left.source == source_a and evidence.right.source == source_b
        assert evidence.left.value == getattr(data[0], source_a)


@pytest.mark.parametrize("params", [
    {"left": {"offset": -1, "source": "close"}}, {"right": {"offset": 1001, "source": "close"}},
    {"left": {"offset": 1.5, "source": "close"}}, {"left": {"offset": True, "source": "close"}},
    {"left": {"offset": 0, "source": "price"}}, {"right": {"offset": 1, "source": "high", "unknown": 1}},
    {"relation": "crosses"}, {"timeframe": "2m"},
])
def test_invalid_operands_relations_and_timeframes_rejected(params):
    with pytest.raises(ValidationError):
        leaf(**params)


@pytest.mark.parametrize("params", [{"lookback": 0}, {"lookback": 1001}, {"lookback": 1.5},
    {"mode": "date_range", "start_date": "2026-07-28", "end_date": "2026-07-20"},
    {"mode": "date_range", "start_date": "2026-07-20", "end_date": "2999-01-01"},
    {"mode": "date_range", "start_date": "2026-02-30", "end_date": "2026-07-20"}])
def test_invalid_periods_rejected(params):
    with pytest.raises(ValidationError):
        leaf("price_compare_period", **params)


def test_each_candidate_shifts_both_operands_relative_to_itself():
    data = [candle(p, start_ms=stamp() + i * 300_000) for i, p in enumerate([100, 120, 110, 90])]
    condition = leaf("price_compare_period", lookback=2,
                     left={"offset": 1, "source": "close"}, right={"offset": 2, "source": "high"})
    events, complete = record(condition, data)
    assert complete and [e.bar_start_ms for e in events] == [data[2].start_ms]
    match = events[0].bar_price_compare_match
    assert match.left.bar_start_ms == data[1].start_ms and match.left.value == 120
    assert match.right.bar_start_ms == data[0].start_ms and match.right.value == 100


def test_relation_is_a_state_not_a_crossing_and_equality_is_exact():
    data = [candle(100), candle(110, start_ms=stamp() + 300_000), candle(120, start_ms=stamp() + 600_000)]
    assert len(record(leaf("price_compare_period"), data)[0]) == 2
    same = leaf(left={"offset": 0, "source": "close"}, right={"offset": 0, "source": "high"}, relation="eq")
    assert record(same, [candle(100)])[0]
    assert record(same, [replace(candle(100), high=100.000000001)]) == ([], True)


def test_missing_invalid_and_live_candles_preserve_positions_and_coverage():
    data = [candle(p, start_ms=stamp() + i * 300_000) for i, p in enumerate([100, 120, 150])]
    events, complete = record(leaf("price_compare_period", lookback=3), data)
    assert len(events) == 2 and not complete
    assert record(leaf(), [data[0]]) == ([], False)
    assert record(leaf(), [replace(data[0], valid=False), data[1]]) == ([], False)
    assert record(leaf(left={"offset": 2, "source": "close"}),
                  [data[0], replace(data[1], valid=False), data[2]]) == ([], False)
    live = [*data[:-1], replace(data[-1], is_open=True)]
    assert record(leaf(), live)[0][0].bar_price_compare_match.left.is_open
    assert record(leaf(include_open_bar=False), live)[0][0].bar_start_ms == data[1].start_ms
    assert record(leaf(), [*data[:-1], replace(live[-1], close=100, low=100)])[0] == []


async def test_calendar_dates_keep_prestart_reference_and_block_future_week_values(corpus):
    condition = leaf("price_compare_period", mode="date_range", start_date="2026-07-21", end_date="2026-07-21")
    assert screener_history_coverage.history_leaves([condition]) == []
    args = dict(data_dir=corpus, codes=["005930"], basis="eod", now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    result = await bars.evaluate(**args, conditions=[condition])
    assert [e.date for _, e in result.events[condition.id]] == ["2026-07-21"]
    assert result.events[condition.id][0][1].bar_price_compare_match.right.bar_start_ms == stamp("2026-07-20", "09:00")
    for timeframe in ["W", "M"]:
        condition = leaf("price_compare_period", mode="date_range", start_date="2026-07-01",
            end_date="2026-07-20", timeframe=timeframe, right={"offset": 0, "source": "open"})
        result = await bars.evaluate(**args, conditions=[condition])
        assert not result.events[condition.id]  # July 21's higher close is outside the cutoff.


@pytest.mark.parametrize("kind, historical", [("price_compare", False), ("price_compare_period", False),
                                           ("price_compare_period", True)])
def test_v2_shifts_from_each_candidate_and_reports_missing_prices(kind, historical):
    days = [dt.date(2026, 7, d) for d in (20, 21, 22, 23)]
    values = {day: dict(open=p, high=p, low=p, close=p) for day, p in zip(days, [100, 120, 110, 130], strict=True)}
    series = screener_series_values.Series({}, values, None, set())
    params = {"mode": "date_range", "start_date": "2026-07-21", "end_date": "2026-07-23"} if historical else (
        {"lookback": 3} if kind == "price_compare_period" else {})
    condition = leaf(kind, **params)
    clock = dt.datetime(2026, 7, 23, 23, tzinfo=KST)
    events, failures = screener_series_eval.evaluate_leaf(condition, "005930", series, days, clock)
    assert not failures
    assert [e.date for e in events] == (["2026-07-21", "2026-07-23"] if kind.endswith("period") else ["2026-07-23"])
    del series.prices[days[-2]]
    _, failures = screener_series_eval.evaluate_leaf(condition, "005930", series, days, clock)
    assert failures and failures[0].reason == "vendor_price_unavailable"


async def test_minutes_adjust_both_operands_with_one_anchor(corpus, monkeypatch):
    prices._FACTORS.clear()
    data = [candle(200, start_ms=stamp("2026-07-27")), candle(110, start_ms=stamp("2026-07-28"))]

    async def snapshot(*args, **kwargs):
        return bars.MinuteSnapshot(data, 123)

    async def factors(key, data_dir, code, anchor):
        assert anchor == "20260728"
        prices._FLIGHTS.pop(key, None)
        return AdjustFactors(anchor, ("20260727", "20260728"), (0.5, 1.0))

    monkeypatch.setattr(bars, "minute_snapshot", snapshot)
    monkeypatch.setattr(prices, "_load_factors", factors)
    result = await bars.evaluate(data_dir=corpus, conditions=[leaf(timeframe="5m")], codes=["005930"],
        basis="intraday", now=dt.datetime(2026, 7, 28, 11, tzinfo=KST))
    match = result.events["price_compare"][0][1].bar_price_compare_match
    assert result.coverage.complete == 1 and (match.left.value, match.right.value) == (110, 100)
    assert data[0].close == 200


async def test_http_evidence_exclusion_before_limit_and_date_mode(corpus):
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        condition = leaf("price_compare_period", lookback=3)
        payload = {"conditions": [condition.model_dump()], "limit": 1}
        response = await client.post("/scan", json=payload)
        assert response.status_code == 200
        row = response.json()["rows"][0]
        assert len(row["occurrences"]) == 2
        for event in row["occurrences"]:
            match = event["bar_price_compare_match"]
            assert match["left"]["value"] > match["right"]["value"]
            assert match["left"]["bar_start_ms"] == event["bar_start_ms"]
            response = await client.put("/exclusions", json={"condition": condition.model_dump(), "code": row["code"],
                "stock_name": row["name"], "date": event["date"], "bar_start_ms": event["bar_start_ms"]})
            assert response.status_code == 200
        after = (await client.post("/scan", json=payload)).json()
        assert after["rows"][0]["code"] != row["code"]
        date = leaf("price_compare_period", mode="date_range", start_date="2026-07-21", end_date="2026-07-21")
        assert screener_exclusions.condition_key(date) == screener_exclusions.condition_key(condition)
        assert screener_exclusions.condition_key(leaf("price_compare_period", left={"offset": 1, "source": "low"})) \
            != screener_exclusions.condition_key(condition)
        response = await client.post("/scan", json={"conditions": [date.model_dump()]})
        assert response.status_code == 200 and len(response.json()["rows"]) == 1


def test_sql_never_silently_ignores_price_operands(corpus):
    with pytest.raises(ValueError, match="봉 이력 평가"):
        screener_scan.run_scan(corpus / "screener/daily_adjusted.parquet", corpus / "screener/stocks.parquet",
            conditions=[leaf()], universe=ScreenerUniverse())


@pytest.mark.parametrize("kind", ["price_compare", "price_compare_period"])
async def test_real_v2_runner_preserves_operand_evidence_and_matches_legacy(corpus, kind):
    data = pl.read_parquet(corpus / "screener/daily_unadjusted.parquet")
    now = dt.datetime(2026, 7, 28, 23, tzinfo=KST)
    for code in data["code"].unique():
        rows = [{**row, "date": row["date"].isoformat()}
                for row in data.filter(pl.col("code") == code).to_dicts()]
        screener_series_store.publish_pair(corpus, code, rows, rows, adjusted_as_of="2026-07-28",
            price_events=[], observed_at=now.isoformat())
    condition = leaf(kind)
    legacy = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[condition]), now=now)
    v2 = await run_screener_scan(data_dir=corpus,
        req=ScanRequest(conditions=[condition], calculation_policy="separate_bases_v2"), now=now)
    assert {row.code for row in v2.rows} == {row.code for row in legacy.rows}
    assert v2.calculation.policy == "separate_bases_v2"
    assert v2.rows[0].occurrences[0].bar_price_compare_match.left.value == 121
    assert v2.rows[0].occurrences[0].bar_price_compare_match.right.value == 110
    assert v2.bar_coverage.complete == legacy.bar_coverage.complete == 2


@pytest.mark.parametrize("expression, matches", [("A AND B", 0), ("A OR B", 2)])
async def test_latest_and_period_conditions_participate_in_expressions(corpus, expression, matches):
    conditions = [leaf(relation="lt"), leaf("price_compare_period", lookback=3)]
    req = ScanRequest(conditions=conditions, expression=expression)
    result = await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    assert len(result.rows) == matches


async def test_recovery_comparison_ignores_only_receipt_time_and_keeps_operand_changes(corpus):
    result = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[leaf()]),
                                   now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    changed = result.model_copy(deep=True)
    match = changed.rows[0].occurrences[0].bar_price_compare_match
    match.fetched_at_ms += 1000
    assert screener_recovery_compare._stable(changed) == screener_recovery_compare._stable(result)
    match.left.value += 0.001
    assert screener_recovery_compare._stable(changed) != screener_recovery_compare._stable(result)


def test_maximum_offset_requires_the_actual_full_comparison_history():
    data = [candle(100 + i, start_ms=stamp() + i * 300_000) for i in range(1001)]
    condition = leaf(right={"offset": 1000, "source": "high"})
    events, complete = record(condition, data)
    assert complete and events[0].bar_price_compare_match.right.value == 100
    assert record(condition, data[1:]) == ([], False)
