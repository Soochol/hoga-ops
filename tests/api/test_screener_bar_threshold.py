"""Independent turnover/latest/period/change semantics, wire evidence and exclusions."""
import datetime as dt
import hashlib
import json
from dataclasses import replace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import (
    screener_bar_price as prices,
    screener_bar_threshold as threshold,
    screener_bar_volume as bars,
    screener_exclusions,
    screener_history_coverage,
    screener_scan,
)
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.live.kiwoom_adjust_factors import AdjustFactors
from hoga.util.timeenc import KST

DEFAULTS = {"trade_value": {"min_eok": 3.0}, "trade_value_period": {"lookback": 3, "min_eok": 3.0},
            "change_pct": {"op": "gte", "pct": 5.0, "lo": None, "hi": None}}


def leaf(kind="trade_value", **params):
    return TypeAdapter(ConditionLeaf).validate_python({"id": kind, "type": kind,
        "params": {**DEFAULTS[kind], **params}})


def stamp(day="2026-07-30", clock="10:00"):
    return int(dt.datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=KST).timestamp() * 1000)


def candle(price=100, volume=100, *, start_ms=None, **kwargs):
    return bars.VolumeBar(start_ms or stamp(), volume, open=price, high=price, low=price, close=price, **kwargs)


def record(condition, data):
    return bars.records(condition, data, fetched_at_ms=123)


@pytest.mark.parametrize("kind", DEFAULTS)
def test_old_defaults_keep_exclusion_hash_and_sql_route(kind):
    condition = leaf(kind)
    params = {k: v for k, v in DEFAULTS[kind].items() if k != "lookback"}
    identity = json.dumps({"type": kind, "params": params}, sort_keys=True, separators=(",", ":"))
    assert screener_exclusions.condition_key(condition) == hashlib.sha256(identity.encode()).hexdigest()
    assert bars.leaves([condition]) == []
    explicit = leaf(kind, timeframe="D", include_open_bar=True,
                    **({"change_reference": "previous_day"} if kind == "change_pct" else {}))
    assert screener_exclusions.condition_key(explicit) == screener_exclusions.condition_key(condition)


@pytest.mark.parametrize("kind", DEFAULTS)
@pytest.mark.parametrize("timeframe", ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "D", "W", "M"])
def test_timeframe_api_roundtrip(kind, timeframe):
    condition = leaf(kind, timeframe=timeframe, include_open_bar=False)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    with pytest.raises(ValidationError):
        leaf(kind, timeframe="2m")


@pytest.mark.parametrize("kind", DEFAULTS)
def test_nonfinite_thresholds_are_rejected(kind):
    for value in [float("nan"), float("inf")]:
        with pytest.raises(ValidationError):
            leaf(kind, **({"pct": value} if kind == "change_pct" else {"min_eok": value}))


def test_turnover_latest_and_period_are_individual_bars_not_cumulative_sum():
    data = [candle(100, 100, start_ms=stamp() + i * 300_000) for i in range(3)]
    latest = leaf(timeframe="5m", min_eok=0.0001)
    events, complete = record(latest, data)
    assert complete and len(events) == 1 and events[0].bar_start_ms == data[-1].start_ms
    assert events[0].bar_trade_value_match.trade_value_won == 10000
    assert record(leaf("trade_value_period", timeframe="5m", min_eok=0.0002), data) == ([], True)
    data[0] = candle(300, 100)
    events, _ = record(leaf("trade_value_period", timeframe="5m", min_eok=0.0002), data)
    assert [event.bar_start_ms for event in events] == [data[0].start_ms]
    assert record(leaf("trade_value_period", timeframe="5m", lookback=1, min_eok=0.0002), data)[0] == []


def test_turnover_partial_history_open_policy_zero_and_invalid_prices():
    current = candle(100, 100, is_open=True)
    condition = leaf("trade_value_period", timeframe="5m", min_eok=0.0001, lookback=60)
    events, complete = record(condition, [current])
    assert events and not complete  # A threshold hit does not require N bars to exist.
    assert record(leaf(timeframe="5m", min_eok=0, include_open_bar=False), [current]) == ([], False)
    assert record(leaf(timeframe="5m", min_eok=0), [candle(volume=0)])[0]
    assert record(leaf(timeframe="5m", min_eok=0), [replace(current, low=None)]) == ([], False)
    assert record(leaf(timeframe="5m", min_eok=0), [candle(volume=-1)]) == ([], False)


@pytest.mark.parametrize("timeframe, dates", [("W", ["2026-07-20", "2026-07-21"]),
                                             ("M", ["2026-07-01", "2026-07-02"])])
def test_week_month_sum_daily_estimates_instead_of_reestimating_aggregated_ohlc(timeframe, dates):
    days = list(map(dt.date.fromisoformat, dates))
    data = {days[0]: candle(100, 1), days[1]: candle(200, 9)}
    grouped = bars.calendar_bars(data, days, timeframe=timeframe,
        as_of=dt.datetime.combine(days[-1], dt.time(10), KST))
    assert grouped[0].trade_value_won == 1900
    assert threshold.estimate(grouped[0]) == 1500  # This aggregate-then-estimate value is not used.
    events, complete = record(leaf(timeframe=timeframe, min_eok=0.000018), grouped)
    assert complete and events[0].bar_trade_value_match.trade_value_won == 1900
    assert events[0].bar_trade_value_match.method == "daily_estimate_sum"
    del data[days[0]]
    missing = bars.calendar_bars(data, days, timeframe=timeframe,
        as_of=dt.datetime.combine(days[-1], dt.time(10), KST))
    assert record(leaf(timeframe=timeframe, min_eok=0), missing) == ([], False)


@pytest.mark.parametrize("op, bounds, matched", [("gte", {"pct": 10}, True), ("lte", {"pct": 10}, True),
    ("between", {"lo": 10, "hi": 10}, True), ("gte", {"pct": 11}, False),
    ("lte", {"pct": 9}, False), ("between", {"lo": -10, "hi": 0}, False)])
def test_change_operators_include_boundaries(op, bounds, matched):
    data = [candle(100), candle(110, start_ms=stamp() + 300_000)]
    condition = leaf("change_pct", timeframe="5m", change_reference="previous_bar", op=op, **bounds)
    events, complete = record(condition, data)
    assert complete and bool(events) is matched
    if matched:
        assert events[0].bar_change_match.change_pct == 10


def test_change_reference_distinguishes_previous_bar_open_and_previous_day():
    data = [candle(100), replace(candle(110, start_ms=stamp() + 300_000), open=105, low=105,
                                previous_day_close=80, previous_day_ms=stamp("2026-07-29", "09:00"))]
    expected = {"previous_bar": 10, "bar_open": 5 / 105 * 100, "previous_day": 37.5}
    for reference, value in expected.items():
        events, complete = record(leaf("change_pct", timeframe="5m", change_reference=reference, pct=-100), data)
        assert complete and events[0].bar_change_match.change_pct == pytest.approx(value)
        assert events[0].bar_change_match.change_reference == reference
    assert record(leaf("change_pct", timeframe="5m", change_reference="previous_bar"), data[-1:]) == ([], False)
    assert record(leaf("change_pct", timeframe="5m"), [candle(100)]) == ([], False)
    assert record(leaf("change_pct", timeframe="5m"), [replace(data[-1], previous_day_close=0)]) == ([], False)
    with pytest.raises(ValidationError):
        leaf("change_pct", change_reference="unknown")


def test_change_live_can_enter_leave_and_closed_only_uses_previous_completed_pair():
    data = [candle(90), candle(100, start_ms=stamp() + 300_000),
            candle(120, start_ms=stamp() + 600_000, is_open=True)]
    condition = leaf("change_pct", timeframe="5m", change_reference="previous_bar", pct=15)
    assert record(condition, data)[0][0].bar_change_match.is_open
    assert record(condition, [*data[:-1], replace(data[-1], close=100, low=100)])[0] == []
    condition = leaf("change_pct", timeframe="5m", change_reference="previous_bar", pct=10, include_open_bar=False)
    assert record(condition, data)[0][0].bar_start_ms == data[1].start_ms


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / "status.json").write_text("{}")
    dates = [dt.date(2026, 7, day) for day in (20, 21, 27, 28)]
    monkeypatch.setattr(bars.trading_days, "trading_days", lambda _: {d.strftime("%Y%m%d") for d in dates})
    data = pl.DataFrame([{"code": code, "date": day, "open": price, "high": price, "low": price,
                         "close": price, "volume": volume}
        for code in ("005930", "000660")
        for day, price, volume in zip(dates, [100.0, 200.0, 110.0, 121.0], [1000000, 9000000, 2000000, 3000000],
                                      strict=True)])
    for name in ("daily_adjusted.parquet", "daily_unadjusted.parquet"):
        data.write_parquet(sdir / name)
    pl.DataFrame([{"code": code, "name": code, "market": "KOSPI", "is_etf": False, "is_halted": False}
                  for code in ("005930", "000660")]).write_parquet(sdir / "stocks.parquet")
    return tmp_path


async def test_weekly_change_previous_day_uses_last_trading_days_previous_close(corpus):
    args = dict(data_dir=corpus, codes=["005930"], basis="eod", now=dt.datetime(2026, 7, 28, 17, tzinfo=KST))
    one = await bars.evaluate(**args, conditions=[leaf("change_pct", timeframe="W", pct=5)])
    match = one.events["change_pct"][0][1].bar_change_match
    assert match.reference_close == 110 and match.change_pct == 10  # Tue vs Mon, not previous week.
    two = await bars.evaluate(**args, conditions=[leaf("change_pct", timeframe="W",
        change_reference="previous_bar", op="lte", pct=0)])
    assert two.events["change_pct"][0][1].bar_change_match.reference_close == 200


async def test_minute_previous_day_uses_raw_daily_and_same_adjustment_anchor(corpus, monkeypatch):
    prices._FACTORS.clear()
    data = [candle(110, start_ms=stamp("2026-07-28"))]
    anchors = []

    async def snapshot(*args, **kwargs):
        return bars.MinuteSnapshot(data, 123)

    async def factors(key, data_dir, code, anchor):
        anchors.append(anchor)
        prices._FLIGHTS.pop(key, None)
        return AdjustFactors(anchor, ("20260727", "20260728"), (0.5, 1.0))

    monkeypatch.setattr(bars, "minute_snapshot", snapshot)
    monkeypatch.setattr(prices, "_load_factors", factors)
    result = await bars.evaluate(data_dir=corpus, conditions=[leaf("change_pct", timeframe="5m")],
        codes=["005930"], basis="intraday", now=dt.datetime(2026, 7, 28, 10, 2, tzinfo=KST))
    match = result.events["change_pct"][0][1].bar_change_match
    assert match.reference_close == 55 and match.close == 110 and match.change_pct == 100
    assert anchors == ["20260728"] and data[0].close == 110


async def test_missing_previous_daily_row_does_not_fall_back_to_older_close(corpus, monkeypatch):
    path = corpus / "screener/daily_unadjusted.parquet"
    pl.read_parquet(path).filter(pl.col("date") != dt.date(2026, 7, 27)).write_parquet(path)
    data = [candle(110, start_ms=stamp("2026-07-28"))]
    prepared, reason = await threshold.prepare_minutes(leaf("change_pct", timeframe="5m"), data,
        corpus, "005930", "20260728")
    assert reason == "missing_reference" and record(leaf("change_pct", timeframe="5m"), prepared) == ([], False)
    path.write_bytes(b"corrupt")
    _, reason = await threshold.prepare_minutes(leaf("change_pct", timeframe="5m"), data,
        corpus, "005930", "20260728")
    assert reason == "missing_reference"


async def test_minute_turnover_never_multiplies_adjusted_price_by_raw_volume(corpus):
    raw = [candle(200, 10)]
    prepared, reason = await threshold.prepare_minutes(leaf(timeframe="5m"), raw, corpus, "005930", "20260730")
    events, complete = record(leaf(timeframe="5m", min_eok=0.00002), prepared)
    assert reason is None and complete and events[0].bar_trade_value_match.trade_value_won == 2000


async def test_date_range_end_blocks_later_week_turnover_and_skips_legacy_jobs(corpus):
    condition = TypeAdapter(ConditionLeaf).validate_python({"id": "range", "type": "trade_value_period",
        "params": {"mode": "date_range", "start_date": "2026-07-20", "end_date": "2026-07-20",
                   "timeframe": "W", "min_eok": 1}})
    assert screener_history_coverage.history_leaves([condition]) == []
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=["005930"], basis="eod",
        now=dt.datetime(2026, 7, 28, 17, tzinfo=KST))
    assert result.events["range"][0][1].bar_trade_value_match.trade_value_won == 100000000
    assert result.events["range"][0][1].bar_trade_value_match.is_open
    assert not bars.needs_daily_overlay(condition, "2026-07-28")


async def test_http_three_conditions_evidence_and_exclusion_before_limit(corpus):
    conditions = [leaf(timeframe="W", min_eok=1),
                  leaf("trade_value_period", timeframe="W", lookback=2, min_eok=10),
                  leaf("change_pct", timeframe="D", change_reference="previous_bar")]
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 28, 17, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        payload = {"conditions": [c.model_dump() for c in conditions], "limit": 1}
        response = await client.post("/scan", json=payload)
        assert response.status_code == 200
        result = response.json()
        row = result["rows"][0]
        events = {e["condition_id"]: e for e in row["occurrences"]}
        assert result["bar_coverage"]["complete"] == 2
        assert events["trade_value"]["bar_trade_value_match"]["method"] == "daily_estimate_sum"
        assert events["trade_value_period"]["date"] == "2026-07-20"
        assert events["change_pct"]["bar_change_match"]["change_reference"] == "previous_bar"
        event = events["trade_value"]
        response = await client.put("/exclusions", json={"condition": conditions[0].model_dump(),
            "code": row["code"], "stock_name": row["name"], "date": event["date"],
            "bar_start_ms": event["bar_start_ms"]})
        assert response.status_code == 200
        after = (await client.post("/scan", json=payload)).json()
        assert after["rows"][0]["code"] != row["code"]


@pytest.mark.parametrize("kind", DEFAULTS)
def test_sql_cannot_ignore_timeframe_without_evaluator(corpus, kind):
    with pytest.raises(ValueError, match="봉 이력 평가"):
        screener_scan.run_scan(corpus / "screener/daily_adjusted.parquet", corpus / "screener/stocks.parquet",
            conditions=[leaf(kind, timeframe="5m")], universe=ScreenerUniverse())


async def test_rest_bypass_blocks_missing_factor_fetch_but_allows_cached_adjustment(tmp_path, monkeypatch):
    prices._FACTORS.clear()
    monkeypatch.setattr(prices.settings, "rest_bypass_enabled", lambda _: True)

    def forbidden(*args):
        raise AssertionError("REST 조회 중지 중에는 새 수정계수를 요청하면 안 됩니다")

    monkeypatch.setattr(prices.kiwoom_rest_runtime, "ensure_rest_client", forbidden)
    data = [candle(200, start_ms=stamp("2026-07-29"))]
    adjusted, reason = await prices.adjusted_minutes(tmp_path, "005930", data, "20260730")
    assert not adjusted[0].valid and reason == "adjustment_unavailable"
    prices._FACTORS[(tmp_path, "005930", "20260730")] = AdjustFactors("20260730", ("20260729",), (0.5,))
    adjusted, reason = await prices.adjusted_minutes(tmp_path, "005930", data, "20260730")
    assert reason is None and adjusted[0].close == 100
