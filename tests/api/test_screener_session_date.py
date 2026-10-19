"""No phantom daily bars, and calendar predicates share SQL's EOD fallback."""
import datetime as dt
from types import SimpleNamespace

import polars as pl
import pytest

from hoga.api import screener_bar_volume as bars, screener_intraday, trading_days
from hoga.api.models import ScanRequest
from hoga.api.screener_runner import run_screener_scan
from hoga.live.quote_models import Quote
from hoga.util.timeenc import KST

CODE = "005930"
OTHER = "000660"
DAILY_CONDITIONS = [
    ("new_high_today", {"period": 4}),
    ("new_high", {"lookback": 1, "period": 4}),
    ("new_high_vol_today", {"period": 2}),
    ("new_high_vol", {"lookback": 1, "period": 2}),
    ("high_off_peak", {"period": 4, "pct": 1, "side": "within"}),
    ("ma", {"period": 4, "source": "high", "relation": "above"}),
    ("change_pct", {"op": "gte", "pct": 1}),
    ("trade_value", {"min_eok": 0}),
    ("trade_value_period", {"min_eok": 0, "lookback": 2}),
    ("price_range", {"min": 200000}),
]


def clock(day="2026-10-20", time="00:05"):
    return dt.datetime.fromisoformat(f"{day}T{time}").replace(tzinfo=KST)


def quote(code=CODE, *, fresh=False):
    return Quote(code, 249000 if fresh else 223500, None, open=207000,
                 high=250000 if fresh else 224000, low=206500, volume=1761)


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sd = tmp_path / "screener"
    sd.mkdir()
    days = ["2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19"]
    data = []
    for code in [CODE, OTHER]:
        for day in [1, 2, 5, 6, 7, 8, 12, 13]:
            data.append({"code": code, "date": dt.date(2026, 10, day), "open": 190000.,
                         "high": 200000., "low": 185000., "close": 195000., "volume": 100})
        for day, high, close, volume in zip(days, [241500., 221500., 222500., 224000.],
                                          [234500., 207500., 217000., 223500.],
                                          [1900, 3433, 1890, 1761], strict=True):
            data.append({"code": code, "date": dt.date.fromisoformat(day), "open": 207000.,
                         "high": high, "low": 204000., "close": close, "volume": volume})
    pl.DataFrame(data).write_parquet(sd / "daily_adjusted.parquet")
    pl.DataFrame({"code": [CODE, OTHER], "name": ["삼성전자", "하이닉스"],
                  "market": ["KOSPI", "KOSPI"], "is_etf": [False, False],
                  "is_halted": [False, False]}).write_parquet(sd / "stocks.parquet")
    (sd / "status.json").write_text("{}")
    calendar = {row["date"].strftime("%Y%m%d") for row in data} | {"20261020", "20261021"}
    monkeypatch.setattr(trading_days, "trading_days", lambda _: calendar)
    return tmp_path


@pytest.fixture
def vendor(monkeypatch):
    state = SimpleNamespace(quotes=[quote()], calls=0)
    monkeypatch.setattr(screener_intraday.kiwoom_rest_runtime, "ensure_rest_client", lambda _: object())
    monkeypatch.setattr(screener_intraday.kiwoom_rest_runtime, "ensure_scheduler", lambda _: object())

    async def run(_, *, client, fetch_fn, **kwargs):
        return await fetch_fn(client)

    async def fetch(*args, **kwargs):
        state.calls += 1
        return state.quotes

    monkeypatch.setattr(screener_intraday.kiwoom_access, "run_with_capacity", run)
    monkeypatch.setattr(screener_intraday.kiwoom_multi_quote, "fetch_multi_price", fetch)
    return state


def request(kind, params, *, basis="intraday"):
    return ScanRequest.model_validate({"conditions": [{"id": "a", "type": kind, "params": params}],
                                      "universe": {"exclude_etf": False}, "basis": basis})


def without_fetch_time(value):
    if isinstance(value, dict):
        return {key: without_fetch_time(item) for key, item in value.items() if key != "fetched_at_ms"}
    if isinstance(value, list):
        return [without_fetch_time(item) for item in value]
    return value


@pytest.mark.parametrize("kind,params", DAILY_CONDITIONS)
async def test_before_open_all_daily_predicates_equal_confirmed_data(corpus, vendor, kind, params):
    # A copied October 19 bar would shift the 4-bar high window past October 14.
    args = dict(data_dir=corpus, now=clock())
    expected = await run_screener_scan(**args, req=request(kind, params, basis="eod"))
    actual = await run_screener_scan(**args, req=request(kind, params))
    assert actual.rows == expected.rows
    assert all(row.price_date == "2026-10-19" for row in actual.rows)
    assert "intraday_fallback_eod" in actual.warnings
    assert vendor.calls == 0


@pytest.mark.parametrize("day,time,reason", [
    ("2026-10-20", "00:05", "intraday_session_closed"),
    ("2026-10-20", "08:59", "intraday_session_closed"),
    ("2026-10-17", "12:00", "intraday_session_closed"),
    ("2026-10-09", "12:00", "intraday_session_closed"),
    ("2026-10-22", "12:00", "intraday_calendar_unavailable"),
])
async def test_overlay_cannot_invent_unopened_or_unknown_session(corpus, vendor, day, time, reason):
    now = clock(day, time)
    result = await screener_intraday.build_intraday_overlay(
        data_dir=corpus, codes=[CODE], now_ms=int(now.timestamp() * 1000))
    assert result.rows.is_empty() and result.fetched_at_ms is None
    assert result.warnings == [reason]
    assert vendor.calls == 0


async def test_overlay_midnight_gate_precedes_cache_and_next_open_is_allowed(corpus, vendor):
    async def at(day, time):
        return await screener_intraday.build_intraday_overlay(
            data_dir=corpus, codes=[CODE], now_ms=int(clock(day, time).timestamp() * 1000))
    closed = await at("2026-10-19", "23:59:59")
    assert closed.rows["date"].to_list() == [dt.date(2026, 10, 19)]
    assert (await at("2026-10-20", "00:00:01")).rows.is_empty()
    assert vendor.calls == 1
    vendor.quotes = [quote(fresh=True)]
    opened = await at("2026-10-20", "09:00")
    assert opened.rows["date"].to_list() == [dt.date(2026, 10, 20)]
    assert opened.rows["high"].to_list() == [250000.]
    assert vendor.calls == 2


@pytest.mark.parametrize("timeframe", ["D", "W", "M"])
async def test_before_monday_open_calendar_conditions_keep_friday_data(corpus, vendor, timeframe):
    path = corpus / "screener/daily_adjusted.parquet"
    pl.read_parquet(path).filter(pl.col("date") < dt.date(2026, 10, 19)).write_parquet(path)
    params = {"period": 1, "timeframe": timeframe, "include_open_bar": timeframe != "D"}
    args = dict(data_dir=corpus, now=clock("2026-10-19", "08:59"))
    expected = await run_screener_scan(**args, req=request("new_high_today", params, basis="eod"))
    actual = await run_screener_scan(**args, req=request("new_high_today", params))
    assert {row.code for row in actual.rows} == {CODE, OTHER}
    assert without_fetch_time([row.model_dump() for row in actual.rows]) == without_fetch_time(
        [row.model_dump() for row in expected.rows])
    assert all(row.price_date == "2026-10-16" for row in actual.rows)
    assert vendor.calls == 0


async def test_runner_normalizes_utc_clock_before_session_date(corpus, vendor):
    actual = await run_screener_scan(data_dir=corpus,
        req=request("price_range", {"min": 200000}),
        now=dt.datetime(2026, 10, 19, 15, 5, tzinfo=dt.UTC))
    assert all(row.price_date == "2026-10-19" for row in actual.rows)
    assert "intraday_session_closed" in actual.warnings
    assert vendor.calls == 0


@pytest.mark.parametrize("timeframe", ["W", "M"])
@pytest.mark.parametrize("kind,params", [
    ("new_high_today", {"period": 1}),
    ("new_high", {"lookback": 1, "period": 1}),
    ("new_high_vol_today", {"period": 1}),
    ("new_high_vol", {"lookback": 1, "period": 1}),
    ("high_off_peak", {"period": 1, "pct": 0, "side": "within"}),
    ("ma", {"period": 1, "relation": "above"}),
    ("trade_value", {"min_eok": 0}),
    ("trade_value_period", {"lookback": 1, "min_eok": 0}),
    ("change_pct", {"op": "gte", "pct": -100}),
])
async def test_calendar_predicates_use_eod_for_quotes_missing_from_partial_overlay(
    corpus, vendor, timeframe, kind, params,
):
    vendor.quotes = [quote(fresh=True)]  # OTHER has confirmed data, but no live quote.
    params = {**params, "timeframe": timeframe}
    args = dict(data_dir=corpus, now=clock(time="10:00"))
    expected = await run_screener_scan(**args, req=request(kind, params, basis="eod"))
    actual = await run_screener_scan(**args, req=request(kind, params))
    expected_other = next(row for row in expected.rows if row.code == OTHER)
    other = next(row for row in actual.rows if row.code == OTHER)
    assert without_fetch_time(other.model_dump()) == without_fetch_time(expected_other.model_dump())
    assert {row.code for row in actual.rows} == {CODE, OTHER}
    assert next(row for row in actual.rows if row.code == CODE).price_date == "2026-10-20"


async def test_daily_fallback_does_not_move_live_minute_predicates_to_yesterday(corpus, vendor, monkeypatch):
    vendor.quotes = []
    seen = []

    async def snapshot(data_dir, code, timeframe, needed, lower, as_of):
        seen.append(as_of)
        bar = bars.VolumeBar(int(clock(time="10:00").timestamp() * 1000), 100)
        return bars.MinuteSnapshot([bar], 123)

    monkeypatch.setattr(bars, "minute_snapshot", snapshot)
    req = request("new_high_today", {"timeframe": "W", "period": 1})
    req.conditions += request("new_high_vol_today", {"timeframe": "5m", "period": 1}).conditions
    req.conditions[1].id = "minute"
    result = await run_screener_scan(data_dir=corpus, req=req, now=clock(time="10:05"))
    assert {row.code for row in result.rows} == {CODE, OTHER}
    assert seen and all(now.date() == dt.date(2026, 10, 20) for now in seen)
    assert all(any(event.condition_id == "minute" and event.date == "2026-10-20"
                   for event in row.occurrences) for row in result.rows)
