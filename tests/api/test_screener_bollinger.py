"""Bollinger crossings, independent price inputs, and real scan/save/exclusion wire paths."""
import datetime as dt
import statistics
from dataclasses import replace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import screener_bar_volume as bars, screener_exclusions, screener_saves, screener_scan
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerSaveWriteRequest, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.util.timeenc import KST


def leaf(*, recent=None, position=False, **params):
    family = "bollinger_position" if position else "bollinger_breakout"
    kind = f"{family}_today" if recent is None else family
    return TypeAdapter(ConditionLeaf).validate_python({"id": kind, "type": kind,
        "params": {"period": 3, "multiplier": 1, **({"lookback": recent} if recent is not None else {}), **params}})


def series(values):
    return [bars.VolumeBar(int(dt.datetime(2026, 7, 20 + i, 9, tzinfo=KST).timestamp() * 1000), 100,
        open=v, high=v + 1, low=v - 1, close=v) for i, v in enumerate(values)]


@pytest.mark.parametrize("source", ["open", "high", "low", "close"])
@pytest.mark.parametrize("band, values", [("upper", [100, 100, 100, 110, 120]),
                                         ("lower", [100, 100, 100, 90, 80])])
def test_only_crossing_bar_matches_and_recent_returns_original_event(source, band, values):
    data = series(values)
    # Same selected value across OHLC, so crossings can be compared exactly.
    data = [replace(b, high=b.close, low=b.close) for b in data]
    condition = leaf(recent=2, source=source, band=band)
    events, complete = bars.records(condition, data, fetched_at_ms=17)
    assert complete and [e.bar_start_ms for e in events] == [data[3].start_ms]
    evidence = events[0].bar_price_match
    window = values[1:4]
    expected = statistics.mean(window) + (1 if band == "upper" else -1) * statistics.pstdev(window)
    assert evidence.reference == pytest.approx(expected)
    assert evidence.value == values[3] and evidence.source == source and evidence.fetched_at_ms == 17
    assert bars.records(leaf(source=source, band=band), data, fetched_at_ms=17) == ([], True)
    assert bars.records(leaf(recent=1, source=source, band=band), data, fetched_at_ms=17) == ([], True)
    latest, _ = bars.records(leaf(source=source, band=band), data[:4], fetched_at_ms=17)
    assert latest[0].bar_price_match == evidence  # No future data in historical bands.


def test_comparison_price_and_band_calculation_price_are_independent():
    data = [replace(b, high=100) for b in series([100, 100, 100, 100])]
    data[-1] = replace(data[-1], high=120, open=110)
    assert bars.records(leaf(source="high"), data, fetched_at_ms=0)[0]
    assert bars.records(leaf(source="open"), data, fetched_at_ms=0)[0]
    assert not bars.records(leaf(source="close"), data, fetched_at_ms=0)[0]
    assert not bars.records(leaf(source="high", band_source="high", multiplier=2), data, fetched_at_ms=0)[0]
    assert not bars.records(leaf(source="close", multiplier=2), series([100] * 4), fetched_at_ms=0)[0]


def test_full_previous_window_invalid_data_and_open_bar_recomputation():
    data = series([100, 100, 100, 110])
    assert bars.records(leaf(), data[-3:], fetched_at_ms=0) == ([], False)
    invalid = [*data[:2], replace(data[2], valid=False), data[3]]
    assert bars.records(leaf(), invalid, fetched_at_ms=0) == ([], False)
    invalid = [replace(data[0], close=float("nan")), *data[1:]]
    assert bars.records(leaf(), invalid, fetched_at_ms=0) == ([], False)
    opened = [*data[:3], replace(data[3], is_open=True)]
    assert bars.records(leaf(), opened, fetched_at_ms=0)[0][0].bar_price_match.is_open
    assert not bars.records(leaf(), [*opened[:3], replace(opened[3], close=100)], fetched_at_ms=0)[0]
    assert bars.records(leaf(include_open_bar=False), opened, fetched_at_ms=0) == ([], False)
    recovered = series([100, 100, 100, 100, 100, 110])
    recovered[0] = replace(recovered[0], valid=False)
    assert bars.records(leaf(), recovered, fetched_at_ms=0)[1]


@pytest.mark.parametrize("patch", [{"period": 1}, {"period": 1.5}, {"period": 1001},
    {"multiplier": 0}, {"multiplier": float("nan")}, {"multiplier": 11},
    {"source": "vwap"}, {"band_source": "vwap"}, {"band": "middle"}, {"lookback": 0}])
def test_invalid_parameters_are_rejected(patch):
    with pytest.raises(ValidationError):
        leaf(recent=2, **patch)


@pytest.mark.parametrize("position", [False, True])
@pytest.mark.parametrize("timeframe", ["1m", "5m", "D", "W", "M"])
def test_models_and_exclusion_identity(timeframe, position):
    condition = leaf(recent=2, timeframe=timeframe, position=position)
    assert TypeAdapter(ConditionLeaf).validate_json(condition.model_dump_json()) == condition
    assert screener_exclusions.condition_key(condition) == screener_exclusions.condition_key(
        leaf(recent=10, timeframe=timeframe, position=position))
    assert bars.leaves([condition]) == [condition]  # Daily Bollinger conditions also use the candle evaluator.


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / "status.json").write_text("{}")
    data = series([100, 100, 100, 110, 120])
    days = [dt.datetime.fromtimestamp(b.start_ms / 1000, KST).date() for b in data]
    monkeypatch.setattr(bars.trading_days, "trading_days", lambda _: {d.strftime("%Y%m%d") for d in days})
    pl.DataFrame([{"code": "005930", "date": d, "open": b.open, "high": b.high, "low": b.low,
        "close": b.close, "volume": b.volume} for d, b in zip(days, data, strict=True)]
    ).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame([{"code": "005930", "name": "삼성전자", "market": "KOSPI", "is_etf": False,
                   "is_halted": False}]).write_parquet(sdir / "stocks.parquet")
    return tmp_path


@pytest.mark.parametrize("position", [False, True])
async def test_daily_http_scan_save_exclusion_and_latest_vs_recent(corpus, position):
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req, now=dt.datetime(2026, 7, 24, 17, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    condition = leaf(recent=2, position=position)
    saved = await screener_saves.create_save(corpus, req=ScreenerSaveWriteRequest(
        name="볼린저 돌파", conditions=[condition]), id="bb", now_ms=1)
    assert screener_saves.load_saves(corpus).saves[0] == saved
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        payload = {"conditions": [condition.model_dump()], "basis": "eod"}
        response = await client.post("/scan", json=payload)
        assert response.status_code == 200
        result = response.json()
        assert result["bar_coverage"]["complete"] == 1
        row = result["rows"][0]
        assert [e["date"] for e in row["occurrences"]] == (
            ["2026-07-23", "2026-07-24"] if position else ["2026-07-23"])
        event = row["occurrences"][0]
        assert event["date"] == "2026-07-23"
        assert event["bar_price_match"]["source"] == "close"
        expected = statistics.mean([100, 100, 110]) + statistics.pstdev([100, 100, 110])
        assert event["bar_price_match"]["reference"] == pytest.approx(expected)
        latest = await client.post("/scan", json={"conditions": [leaf(position=position).model_dump()], "basis": "eod"})
        assert latest.status_code == 200
        assert bool(latest.json()["rows"]) is position
        for event in row["occurrences"]:
            excluded = await client.put("/exclusions", json={"condition": condition.model_dump(), "code": row["code"],
                "stock_name": row["name"], "date": event["date"], "bar_start_ms": event["bar_start_ms"]})
            assert excluded.status_code == 200
        assert (await client.post("/scan", json=payload)).json()["rows"] == []


@pytest.mark.parametrize("position", [False, True])
def test_direct_scan_requires_precomputed_bands(corpus, position):
    with pytest.raises(ValueError, match="봉 이력 평가"):
        screener_scan.run_scan(corpus / "screener/daily_adjusted.parquet", corpus / "screener/stocks.parquet",
            conditions=[leaf(position=position)], universe=ScreenerUniverse())


@pytest.mark.parametrize("position, needed", [(False, 4), (True, 3)])
async def test_minute_fetch_includes_required_band_window(tmp_path, monkeypatch, position, needed):
    data = series([100, 100, 100, 110])
    anchor = data[0].start_ms
    data = [replace(b, start_ms=anchor + i * 300_000) for i, b in enumerate(data)]
    requested = []

    async def snapshot(data_dir, code, timeframe, needed, lower, as_of):
        requested.append(needed)
        return bars.MinuteSnapshot(data, 123)

    monkeypatch.setattr(bars, "minute_snapshot", snapshot)
    condition = leaf(timeframe="5m", position=position)
    result = await bars.evaluate(data_dir=tmp_path, conditions=[condition], codes=["005930"],
        basis="intraday", now=dt.datetime(2026, 7, 20, 10, tzinfo=KST))
    assert requested == [needed] and result.coverage.complete == 1
    assert result.events[condition.id][0][1].bar_start_ms == data[-1].start_ms
    assert result.events[condition.id][0][1].bar_price_match.fetched_at_ms == 123


@pytest.mark.parametrize("position", [False, True])
async def test_live_daily_overlay_can_enter_and_leave_condition(corpus, position):
    condition = leaf(position=position)
    now = dt.datetime(2026, 7, 23, 10, tzinfo=KST)
    overlay = pl.DataFrame({"code": ["005930"], "date": [now.date()], "open": [100.0],
                           "high": [111.0], "low": [99.0], "close": [110.0], "volume": [100]})
    args = dict(data_dir=corpus, conditions=[condition], codes=["005930"], basis="intraday", now=now)
    result = await bars.evaluate(**args, overlay=overlay)
    assert result.coverage.complete == 1
    assert result.events[condition.id][0][1].bar_price_match.is_open
    result = await bars.evaluate(**args, overlay=overlay.with_columns(pl.lit(100.0).alias("close")))
    assert result.coverage.complete == 1 and result.events[condition.id] == []


def test_large_price_centered_variance_matches_independent_population_reference():
    from hoga.api.screener_bollinger import _bands

    values = [1_000_000_000 + (i * 17 % 23) / 10 for i in range(83)]
    actual = list(_bands(values, [True] * len(values), period=20, multiplier=2, band_side="upper"))
    assert actual[:19] == [None] * 19
    for i in range(19, len(values)):
        window = values[i - 19:i + 1]
        expected = statistics.mean(window) + 2 * statistics.pstdev(window)
        assert actual[i] == pytest.approx(expected, abs=0.000001, rel=0)


@pytest.mark.parametrize("source", ["open", "high", "low", "close"])
@pytest.mark.parametrize("band, values", [("upper", [100, 100, 100, 110, 120]),
                                         ("lower", [100, 100, 100, 90, 80])])
def test_position_keeps_every_outside_bar_and_latest_without_new_crossing(source, band, values):
    data = [replace(b, high=b.close, low=b.close) for b in series(values)]
    args = dict(position=True, source=source, band=band)
    events, complete = bars.records(leaf(recent=2, **args), data, fetched_at_ms=17)
    assert complete and [e.bar_start_ms for e in events] == [b.start_ms for b in data[-2:]]
    for i, event in enumerate(events, start=3):
        window = values[i - 2:i + 1]
        expected = statistics.mean(window) + (1 if band == "upper" else -1) * statistics.pstdev(window)
        assert event.bar_price_match.reference == pytest.approx(expected)
        assert event.bar_price_match.value == values[i]
    latest, complete = bars.records(leaf(**args), data, fetched_at_ms=17)
    assert complete and len(latest) == 1
    assert latest[0].bar_price_match == events[-1].bar_price_match
    # A historical outside position still counts when the latest bar is back inside.
    data.append(replace(data[-1], start_ms=data[-1].start_ms + 86_400_000, open=100, high=100, low=100, close=100))
    assert bars.records(leaf(**args), data, fetched_at_ms=17) == ([], True)
    assert bars.records(leaf(recent=2, **args), data, fetched_at_ms=17) == (events[-1:], True)


@pytest.mark.parametrize("band, source, outside", [("upper", "high", 110), ("lower", "low", 90)])
def test_position_current_window_equality_and_independent_price_sources(band, source, outside):
    data = [replace(b, open=100, high=100, low=100, close=100) for b in series([100] * 3)]
    condition = leaf(position=True, band=band, source=source, multiplier=2)
    assert bars.records(condition, data, fetched_at_ms=0) == ([], True)  # Equality is excluded.
    data[-1] = replace(data[-1], **{source: outside})
    events, complete = bars.records(condition, data, fetched_at_ms=0)
    assert complete and events[0].bar_price_match.reference == 100
    assert events[0].bar_price_match.window_start_ms == data[0].start_ms
    assert bars.records(leaf(position=True, band=band), data, fetched_at_ms=0) == ([], True)
    assert bars.records(leaf(position=True, band=band, source=source, band_source=source, multiplier=2),
                        data, fetched_at_ms=0) == ([], True)
    assert bars.records(condition, data[1:], fetched_at_ms=0) == ([], False)
    invalid = [replace(data[0], valid=False), *data[1:]]
    assert bars.records(condition, invalid, fetched_at_ms=0) == ([], False)
    opened = [*data[:-1], replace(data[-1], is_open=True)]
    assert bars.records(condition, opened, fetched_at_ms=0)[0][0].bar_price_match.is_open
    assert bars.records(leaf(position=True, include_open_bar=False), opened, fetched_at_ms=0) == ([], False)
