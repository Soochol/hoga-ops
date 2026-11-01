"""SMA operand windows, crossing events and signed percentage semantics."""
import datetime as dt
import operator
from dataclasses import replace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import (
    screener_bar_policy,
    screener_bar_price as prices,
    screener_bar_volume as bars,
    screener_exclusions,
    screener_history_coverage,
    screener_recovery_compare,
    screener_scan,
    screener_series_store,
)
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerSaveWriteRequest, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.live.kiwoom_adjust_factors import AdjustFactors
from hoga.util.timeenc import KST
from tests.api.test_screener_bar_threshold import candle, record, seed_threshold_corpus, stamp

KINDS = ["ma_compare", "ma_cross", "ma_gap", "ma_slope"]


def average(period=2, source="close", offset=0):
    return dict(kind="sma", period=period, source=source, offset=offset)


def price(source="close", offset=0):
    return dict(kind="price", source=source, offset=offset)


def leaf(kind="ma_compare", **params):
    base = kind.removesuffix("_period")
    defaults = (dict(average=average(), lag=1, op="gte", pct=0) if base == "ma_slope"
                else dict(left=price(), right=average()))
    defaults.update({"relation": "gt"} if base == "ma_compare" else {"direction": "up"} if base == "ma_cross"
                    else {"op": "gte", "pct": 0} if base == "ma_gap" else {})
    if kind.endswith("_period") and "mode" not in params:
        defaults["lookback"] = 2
    return TypeAdapter(ConditionLeaf).validate_python(dict(id=kind, type=kind, params=defaults | params))


def candles(values):
    return [candle(p, start_ms=stamp() + i * 300_000) for i, p in enumerate(values)]


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    return seed_threshold_corpus(tmp_path, monkeypatch)


@pytest.mark.parametrize("kind", [k + suffix for k in KINDS for suffix in ["", "_period"]])
@pytest.mark.parametrize("timeframe", ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "D", "W", "M"])
def test_roundtrip_bounded_operands_and_candle_routing(kind, timeframe):
    condition = leaf(kind, timeframe=timeframe)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    assert bars.leaves([condition]) == [condition]
    saved = ScreenerSaveWriteRequest(name="이동평균", conditions=[condition])
    assert ScreenerSaveWriteRequest.model_validate_json(saved.model_dump_json()) == saved


@pytest.mark.parametrize("source_a", ["open", "high", "low", "close"])
@pytest.mark.parametrize("source_b", ["open", "high", "low", "close"])
@pytest.mark.parametrize("relation, compare", [("gt", operator.gt), ("gte", operator.ge), ("lt", operator.lt),
                                            ("lte", operator.le), ("eq", operator.eq)])
def test_independent_price_and_sma_sources(source_a, source_b, relation, compare):
    data = [replace(candle(100), open=90, high=110, low=80), replace(candle(120), open=110, high=130, low=100)]
    left, right = getattr(data[-1], source_a), sum(getattr(b, source_b) for b in data) / 2
    events, complete = record(leaf(left=price(source_a), right=average(source=source_b), relation=relation), data)
    assert complete and bool(events) == compare(left, right)
    if events:
        match = events[0].bar_ma_match
        assert match.left.value == left and match.right.value == right
        assert match.right.window_start_ms == data[0].start_ms


@pytest.mark.parametrize("direction, data", [("up", [100, 100, 110, 120, 120]), ("down", [100, 100, 90, 80, 80])])
def test_crossing_includes_departure_from_equality_but_not_touch_or_staying_outside(direction, data):
    condition = leaf("ma_cross_period", lookback=3, direction=direction)
    events, complete = record(condition, candles(data))
    assert complete and len(events) == 1
    match = events[0].bar_ma_match
    assert match.previous_left.value == match.previous_right.value == 100
    assert match.left.value != match.right.value
    assert events[0].bar_start_ms == candles(data)[2].start_ms
    assert record(leaf("ma_cross"), candles([100, 100, 100])) == ([], True)


def test_ma_to_ma_cross_uses_full_current_and_previous_windows():
    data = candles([100, 100, 90, 120, 130])
    condition = leaf("ma_cross_period", lookback=2, left=average(2), right=average(3))
    events, complete = record(condition, data)
    assert complete and len(events) == 1 and events[0].bar_start_ms == data[3].start_ms
    match = events[0].bar_ma_match
    assert match.left.value == 105 and match.right.value == pytest.approx(310 / 3)
    assert match.previous_left.value == 95 and match.previous_right.value == pytest.approx(290 / 3)
    assert record(leaf("ma_cross", left=average(2), right=average(3)), data[:3]) == ([], False)


@pytest.mark.parametrize("values, expected", [([90, 110], 10), ([110, 90], -10), ([100, 100], 0)])
@pytest.mark.parametrize("op", ["gte", "lte", "between"])
def test_gap_is_signed_and_zero_based_with_inclusive_boundaries(values, expected, op):
    params = dict(op=op, **({"lo": expected, "hi": expected} if op == "between" else {"pct": expected}))
    events, complete = record(leaf("ma_gap", **params), candles(values))
    assert complete and events[0].bar_ma_match.value_pct == expected


def test_slope_compares_requested_prior_average_not_price_or_angle():
    data = candles([80, 100, 100, 120, 120])
    events, complete = record(leaf("ma_slope", lag=2, pct=20), data)
    assert complete and events[0].bar_ma_match.value_pct == 20
    match = events[0].bar_ma_match
    assert (match.left.value, match.right.value) == (120, 100)
    assert match.right.offset == 2 and match.right.window_start_ms == data[1].start_ms
    events, complete = record(leaf("ma_slope", average=average(offset=1), lag=2, pct=0), data)
    assert complete and events[0].bar_ma_match.value_pct == pytest.approx((110 / 90 - 1) * 100)


@pytest.mark.parametrize("kind", KINDS)
def test_missing_or_invalid_history_never_uses_shortened_sma(kind):
    data = candles([100, 100, 120])
    assert record(leaf(kind), data[:1]) == ([], False)
    assert record(leaf(kind), [data[0], replace(data[1], valid=False), data[2]]) == ([], False)
    assert record(leaf(kind), [data[0], replace(data[1], close=0), data[2]]) == ([], False)


def test_latest_period_and_live_reference_positions_are_distinct():
    data = candles([100, 100, 120, 100])
    events, complete = record(leaf("ma_compare_period", lookback=2), data)
    assert complete and [e.bar_start_ms for e in events] == [data[2].start_ms]
    assert record(leaf(), data) == ([], True)
    live = [*data[:-1], replace(data[-1], close=140, high=140, is_open=True)]
    assert record(leaf(), live)[0][0].bar_ma_match.is_open
    assert record(leaf(include_open_bar=False), live)[0][0].bar_start_ms == data[2].start_ms
    assert not record(leaf("ma_compare_period", lookback=10), data)[1]


@pytest.mark.parametrize("kind, params", [
    ("ma_compare", {"left": price(), "right": price()}),
    ("ma_compare", {"right": average(period=0)}), ("ma_compare", {"right": average(period=1001)}),
    ("ma_compare", {"right": average(period=1.5)}), ("ma_compare", {"right": average(period=True)}),
    ("ma_compare", {"right": {"kind": "ema", "period": 20, "source": "close", "offset": 0}}),
    ("ma_cross", {"direction": "both"}), ("ma_gap", {"pct": float("nan")}),
    ("ma_gap", {"op": "between", "lo": 2, "hi": -2}), ("ma_slope", {"lag": 0}),
    ("ma_slope", {"lag": 1001}), ("ma_slope", {"lag": 1.5}), ("ma_slope", {"average": price()}),
    ("ma_gap_period", {"lookback": 1001}),
    ("ma_cross_period", {"mode": "date_range", "start_date": "2026-07-28", "end_date": "2026-07-20"}),
])
def test_invalid_inputs_are_rejected(kind, params):
    with pytest.raises(ValidationError):
        leaf(kind, **params)


@pytest.mark.parametrize("kind", KINDS)
async def test_historical_windows_keep_warmup_and_v2_matches_legacy(corpus, kind):
    condition = leaf(kind + "_period", mode="date_range", start_date="2026-07-28", end_date="2026-07-28",
                     **({"op": "lte", "pct": 0} if kind == "ma_slope" else {}))
    assert screener_history_coverage.history_leaves([condition]) == []
    now = dt.datetime(2026, 7, 28, 23, tzinfo=KST)
    frame = pl.read_parquet(corpus / "screener/daily_adjusted.parquet")
    for code in frame["code"].unique():
        rows = [{**row, "date": row["date"].isoformat()} for row in frame.filter(pl.col("code") == code).to_dicts()]
        screener_series_store.publish_pair(corpus, code, rows, rows, adjusted_as_of="2026-07-28",
                                          price_events=[], observed_at=now.isoformat())
    old = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[condition]), now=now)
    new = await run_screener_scan(data_dir=corpus,
        req=ScanRequest(conditions=[condition], calculation_policy="separate_bases_v2"), now=now)
    assert {row.code for row in old.rows} == {row.code for row in new.rows} == {"005930", "000660"}
    assert old.rows[0].occurrences[0].bar_ma_match.left.value == new.rows[0].occurrences[0].bar_ma_match.left.value
    assert new.rows[0].occurrences[0].date == "2026-07-28"


async def test_weekly_date_cutoff_blocks_later_close(corpus):
    condition = leaf("ma_compare_period", timeframe="W", mode="date_range",
                     start_date="2026-07-27", end_date="2026-07-27", right=average(1, source="open"))
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=["005930"], basis="eod",
                                now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    assert not result.events[condition.id]  # Only Monday's 110 enters this weekly SMA, not Tuesday's 121.


async def test_minutes_share_one_price_adjustment_anchor(corpus, monkeypatch):
    prices._FACTORS.clear()
    data = [candle(200, start_ms=stamp("2026-07-27")), candle(120, start_ms=stamp("2026-07-28"))]

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
    match = result.events["ma_compare"][0][1].bar_ma_match
    assert result.coverage.complete == 1 and match.right.value == 110
    assert data[0].close == 200


async def test_http_all_four_conditions_evidence_and_exclusion_before_limit(corpus):
    conditions = [leaf(), leaf("ma_cross"), leaf("ma_gap"), leaf("ma_slope", op="lte", pct=0)]
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        payload = dict(conditions=[c.model_dump() for c in conditions], limit=1)
        response = await client.post("/scan", json=payload)
        assert response.status_code == 200
        result = response.json()
        row = result["rows"][0]
        assert {e["bar_ma_match"]["kind"] for e in row["occurrences"]} == {"compare", "cross", "gap", "slope"}
        match = row["occurrences"][0]["bar_ma_match"]
        assert match["left"]["value"] > 0 and match["right"]["window_start_ms"] > 0
        event = next(e for e in row["occurrences"] if e["condition_id"] == "ma_compare")
        response = await client.put("/exclusions", json=dict(condition=conditions[0].model_dump(), code=row["code"],
            stock_name=row["name"], date=event["date"], bar_start_ms=event["bar_start_ms"]))
        assert response.status_code == 200
        assert (await client.post("/scan", json=payload)).json()["rows"][0]["code"] != row["code"]


@pytest.mark.parametrize("kind", KINDS)
def test_date_and_lookback_do_not_change_occurrence_identity(corpus, kind):
    recent = leaf(kind + "_period", lookback=20)
    historical = leaf(kind + "_period", mode="date_range", start_date="2026-07-20", end_date="2026-07-28")
    assert screener_exclusions.condition_key(recent) == screener_exclusions.condition_key(historical)
    with pytest.raises(ValueError, match="봉 이력 평가"):
        screener_scan.run_scan(corpus / "screener/daily_adjusted.parquet", corpus / "screener/stocks.parquet",
                               conditions=[recent], universe=ScreenerUniverse())


def test_required_history_includes_operand_offsets_and_previous_cross_window():
    assert screener_bar_policy.comparison_period(leaf("ma_cross", left=average(5, offset=3), right=average(20))) == 21
    assert screener_bar_policy.comparison_period(leaf("ma_slope", average=average(20, offset=3), lag=5)) == 28


async def test_recovery_comparison_keeps_sma_values_but_ignores_receipt_time(corpus):
    req = ScanRequest(conditions=[leaf()])
    result = await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 23, tzinfo=KST))
    changed = result.model_copy(deep=True)
    match = changed.rows[0].occurrences[0].bar_ma_match
    match.fetched_at_ms += 1000
    assert screener_recovery_compare._stable(changed) == screener_recovery_compare._stable(result)
    match.right.value += 0.1
    assert screener_recovery_compare._stable(changed) != screener_recovery_compare._stable(result)
