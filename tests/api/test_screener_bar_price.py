"""Price candle semantics, shared raw minute input, and real HTTP serialization."""
import datetime as dt
import hashlib
import json
from dataclasses import replace
from types import SimpleNamespace

import polars as pl
import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import TypeAdapter, ValidationError

from hoga.api import screener_bar_price as prices, screener_bar_volume as bars, screener_exclusions, screener_scan
from hoga.api.models import ConditionLeaf, ScanRequest, ScreenerResponse, ScreenerUniverse
from hoga.api.screener_runner import run_screener_scan
from hoga.live.kiwoom_adjust_factors import AdjustFactors
from hoga.util.timeenc import KST

TYPES = {"new_high_today": {"period": 3}, "new_high": {"lookback": 2, "period": 3},
         "new_high_vol_today": {"period": 3}, "high_off_peak": {"period": 3, "pct": 10.0, "side": "within"},
         "ma": {"period": 3, "relation": "above", "source": "close"}}


def leaf(kind="new_high_today", **params):
    return TypeAdapter(ConditionLeaf).validate_python(
        {"id": kind, "type": kind, "params": {**TYPES[kind], **params}})


def stamp(day="2026-07-30", clock="10:00"):
    return int(dt.datetime.fromisoformat(f"{day}T{clock}").replace(tzinfo=KST).timestamp() * 1000)


def series(highs):
    return [bars.VolumeBar(stamp() + i * 300_000, i + 10, open=h - 2, high=h, low=h - 4, close=h - 1)
            for i, h in enumerate(highs)]


@pytest.mark.parametrize("kind", TYPES)
def test_old_defaults_and_exclusion_identity_remain_exact(kind):
    original = leaf(kind)
    explicit = leaf(kind, timeframe="D", include_open_bar=True)
    payload = json.dumps({"type": kind, "params": {k: v for k, v in TYPES[kind].items() if k != "lookback"}},
                         sort_keys=True, separators=(",", ":"))
    assert screener_exclusions.condition_key(original) == hashlib.sha256(payload.encode()).hexdigest()
    assert screener_exclusions.condition_key(original) == screener_exclusions.condition_key(explicit)
    assert bars.leaves([original]) == []
    assert bars.leaves([leaf(kind, timeframe="W")])
    with pytest.raises(ValidationError):
        leaf(kind, timeframe="2m")


@pytest.mark.parametrize("kind", TYPES)
@pytest.mark.parametrize("timeframe", ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "D", "W", "M"])
def test_timeframe_wire_roundtrip(kind, timeframe):
    item = leaf(kind, timeframe=timeframe, include_open_bar=False)
    assert TypeAdapter(ConditionLeaf).validate_json(item.model_dump_json()) == item


def test_latest_high_equals_period_one_and_future_high_does_not_rewrite_events():
    data = series([100, 110, 110, 90, 200])
    recent, complete = bars.records(leaf("new_high", timeframe="5m", lookback=3, period=2), data,
                                    fetched_at_ms=7)
    assert complete and [e.bar_start_ms for e in recent] == [data[2].start_ms, data[4].start_ms]
    assert recent[0].bar_price_match.reference == 110
    latest, _ = bars.records(leaf(timeframe="5m", period=2), data, fetched_at_ms=7)
    single, _ = bars.records(leaf("new_high", timeframe="5m", lookback=1, period=2), data, fetched_at_ms=7)
    assert latest[0].bar_price_match == single[0].bar_price_match
    assert latest[0].bar_start_ms == data[-1].start_ms
    assert not bars.records(leaf(timeframe="5m", period=6), data, fetched_at_ms=0)[0]


@pytest.mark.parametrize("source", ["open", "high", "low", "close"])
def test_ma_uses_selected_source_and_full_window(source):
    data = series([100, 110, 120])
    condition = leaf("ma", timeframe="5m", source=source)
    events, complete = bars.records(condition, data, fetched_at_ms=1)
    match = events[0].bar_price_match
    assert complete and match.source == source
    assert match.value == getattr(data[-1], source)
    assert match.reference == sum(getattr(b, source) for b in data) / 3
    assert bars.records(leaf("ma", timeframe="5m", source=source, relation="below"), data,
                        fetched_at_ms=1)[0] == []
    assert bars.records(condition, data[-2:], fetched_at_ms=1) == ([], False)


def test_open_ma_can_enter_and_leave_while_closed_policy_keeps_last_completed_bar():
    closed = series([100, 110, 120])
    open_bar = replace(series([130])[0], start_ms=closed[-1].start_ms + 300_000, is_open=True)
    condition = leaf("ma", timeframe="5m")
    assert bars.records(condition, closed + [open_bar], fetched_at_ms=1)[0][0].bar_price_match.is_open
    falling = replace(open_bar, close=70, low=65)
    assert bars.records(condition, closed + [falling], fetched_at_ms=2)[0] == []
    events, _ = bars.records(leaf("ma", timeframe="5m", include_open_bar=False), closed + [falling],
                             fetched_at_ms=2)
    assert events[0].bar_start_ms == closed[-1].start_ms and not events[0].bar_price_match.is_open


def test_high_off_peak_uses_high_not_close_and_preserves_partial_history_behavior():
    data = series([100, 80, 90])
    data[-1] = replace(data[-1], close=60, low=55)
    events, complete = bars.records(leaf("high_off_peak", timeframe="5m"), data, fetched_at_ms=0)
    assert complete and events[0].bar_price_match.value == 90
    assert bars.records(leaf("high_off_peak", timeframe="5m", side="outside"), data, fetched_at_ms=0)[0] == []
    events, complete = bars.records(leaf("high_off_peak", timeframe="5m", period=250), data, fetched_at_ms=0)
    assert events and not complete  # Old predicate allows known partial highs; coverage remains explicit.


def test_invalid_price_only_invalidates_dependent_windows_and_ma_recovers_from_nan():
    data = series([100, 110, 120, 130, 140])
    data[1] = replace(data[1], close=float("nan"))
    condition = leaf("new_high", timeframe="5m", lookback=4, period=2)
    events, complete = bars.records(condition, data, fetched_at_ms=0)
    assert not complete and [e.bar_start_ms for e in events] == [data[3].start_ms, data[4].start_ms]
    events, complete = bars.records(leaf("ma", timeframe="5m", period=2), data, fetched_at_ms=0)
    assert complete and events[0].bar_price_match.reference == 134


@pytest.mark.parametrize("timeframe, dates", [("W", ["2026-07-20", "2026-07-21"]),
                                             ("M", ["2026-07-01", "2026-07-02"])])
def test_calendar_ohlc_aggregation_and_missing_days(timeframe, dates):
    days = list(map(dt.date.fromisoformat, dates))
    rows = series([100, 120])
    values = dict(zip(days, rows, strict=True))
    grouped = bars.calendar_bars(values, days, timeframe=timeframe,
        as_of=dt.datetime.combine(days[-1], dt.time(10), KST))
    assert len(grouped) == 1
    bar = grouped[0]
    assert (bar.open, bar.high, bar.low, bar.close, bar.volume) == (98, 120, 96, 119, 21)
    assert bar.is_open
    del values[days[0]]
    assert not bars.calendar_bars(values, days, timeframe=timeframe,
        as_of=dt.datetime.combine(days[-1], dt.time(10), KST))[0].valid


@pytest.fixture
def vendor(monkeypatch):
    bars._CACHE.clear()
    prices._FACTORS.clear()
    bars._CURSORS.clear()
    calls = []
    raw = [{"cntr_tm": day + clock, "cur_prc": str(high - 1), "open_pric": str(high - 2),
            "high_pric": str(high), "low_pric": str(high - 4), "trde_qty": str(volume)}
           for day, clock, high, volume in [("20260729", "153000", 200, 10),
                                            ("20260730", "100000", 110, 20),
                                            ("20260730", "100500", 120, 30)]]

    class Client:
        async def call(self, api_id, params):
            calls.append((api_id, params))
            if api_id == "ka10080":
                return SimpleNamespace(rows=[row for row in raw if row["cntr_tm"][:8] <= params["base_dt"]])
            return SimpleNamespace(rows=[{"dt": "20260729", "cur_prc": "100" if params["upd_stkpc_tp"] == "1"
                                         else "200"}, {"dt": "20260730", "cur_prc": "120"}])

    monkeypatch.setattr(bars.kiwoom_rest_runtime, "ensure_rest_client", lambda _: Client())
    monkeypatch.setattr(bars.kiwoom_rest_runtime, "ensure_scheduler", lambda _: object())

    async def run(_, *, client, fetch_fn, **kwargs):
        return await fetch_fn(client)

    monkeypatch.setattr(bars.kiwoom_access, "run_with_capacity", run)
    return calls


async def test_minute_conditions_share_raw_fetch_and_fixed_anchor_adjustment(tmp_path, vendor):
    conditions = [leaf("new_high_today", timeframe="5m"), leaf("ma", timeframe="5m"),
                  leaf("new_high_vol_today", timeframe="5m")]
    args = dict(data_dir=tmp_path, conditions=conditions, codes=["005930"], basis="intraday",
                now=dt.datetime(2026, 7, 30, 10, 7, tzinfo=KST))
    result = await bars.evaluate(**args)
    assert result.coverage.complete == 1
    assert all(result.events[c.id] for c in conditions)
    assert result.events["ma"][0][1].bar_price_match.reference == (99.5 + 109 + 119) / 3
    assert result.events["new_high_vol_today"][0][1].bar_match.volume == 30
    minute_calls = [p for api, p in vendor if api == "ka10080"]
    assert len(minute_calls) == 2 and all(p["upd_stkpc_tp"] == "0" for p in minute_calls)
    factor_calls = [p for api, p in vendor if api == "ka10081"]
    assert len(factor_calls) == 2 and {p["base_dt"] for p in factor_calls} == {"20260730"}
    await bars.evaluate(**args)
    assert len(vendor) == 4  # Both the raw history and one factor pair are shared.


async def test_missing_adjustment_never_compares_unadjusted_history(tmp_path, monkeypatch):
    data = [replace(series([200])[0], start_ms=stamp("2026-07-29")), *series([110, 120])]

    async def empty(*args, **kwargs):
        return AdjustFactors("20260730", (), ())

    prices._FACTORS.clear()
    monkeypatch.setattr(prices, "_load_factors", empty)
    adjusted, reason = await prices.adjusted_minutes(tmp_path, "005930", data, "20260730")
    assert reason == "adjustment_unavailable" and not adjusted[0].valid
    assert bars.records(leaf(timeframe="5m"), adjusted, fetched_at_ms=0) == ([], False)
    assert data[0].valid and data[0].high == 200  # Raw shared cache remains untouched.
    prices._FLIGHTS.clear()


@pytest.fixture
def corpus(tmp_path, monkeypatch):
    sdir = tmp_path / "screener"
    sdir.mkdir()
    (sdir / "status.json").write_text("{}")
    dates = [dt.date(2026, 7, day) for day in (20, 21, 27, 28)]
    monkeypatch.setattr(bars.trading_days, "trading_days", lambda _: {d.strftime("%Y%m%d") for d in dates})
    pl.DataFrame([{"code": code, "date": day, "open": 90.0, "high": high,
                   "low": 80.0, "close": high - 1, "volume": 100}
                  for code in ("005930", "000660") for day, high in zip(dates, [100.0, 110.0, 120.0, 130.0],
                                                                        strict=True)]
                 ).write_parquet(sdir / "daily_adjusted.parquet")
    pl.DataFrame([{"code": code, "name": code, "market": "KOSPI", "is_etf": False, "is_halted": False}
                  for code in ("005930", "000660")]).write_parquet(sdir / "stocks.parquet")
    return tmp_path


async def test_http_mixed_timeframes_evidence_exclusions_and_daily_overlay(corpus):
    conditions = [leaf("new_high", timeframe="W", period=2, lookback=1),
                  leaf("ma", timeframe="D", include_open_bar=False, period=2)]
    app = FastAPI()

    @app.post("/scan", response_model=ScreenerResponse)
    async def scan(req: ScanRequest):
        return await run_screener_scan(data_dir=corpus, req=req,
                                      now=dt.datetime(2026, 7, 28, 17, tzinfo=KST))

    app.include_router(screener_exclusions.build_router(corpus))
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        payload = {"conditions": [c.model_dump() for c in conditions], "basis": "eod", "limit": 1}
        result = (await client.post("/scan", json=payload)).json()
        assert len(result["rows"]) == 1 and result["bar_coverage"]["complete"] == 2
        row = result["rows"][0]
        assert {e["bar_price_match"]["timeframe"] for e in row["occurrences"]} == {"W", "D"}
        weekly = next(e for e in row["occurrences"] if e["condition_id"] == "new_high")
        assert weekly["bar_price_match"]["value"] == 130
        assert weekly["bar_price_match"]["window_start_ms"] == stamp("2026-07-20", "09:00")
        response = await client.put("/exclusions", json={"condition": conditions[0].model_dump(),
            "code": row["code"], "stock_name": row["name"], "date": weekly["date"],
            "bar_start_ms": weekly["bar_start_ms"]})
        assert response.status_code == 200
        after = (await client.post("/scan", json=payload)).json()
        assert after["rows"][0]["code"] != row["code"]  # Exclusion precedes AND and result limit.


def test_sql_refuses_to_silently_treat_minute_prices_as_daily(corpus):
    for kind in TYPES:
        with pytest.raises(ValueError, match="봉 이력 평가"):
            screener_scan.run_scan(corpus / "screener/daily_adjusted.parquet", corpus / "screener/stocks.parquet",
                conditions=[leaf(kind, timeframe="5m")], universe=ScreenerUniverse())


@pytest.mark.parametrize("kind", TYPES)
async def test_completed_daily_predicate_matches_legacy_sql(corpus, kind):
    now = dt.datetime(2026, 7, 28, 17, tzinfo=KST)
    default = leaf(kind)
    legacy = await run_screener_scan(data_dir=corpus, req=ScanRequest(conditions=[default]), now=now)
    selected = await run_screener_scan(data_dir=corpus,
        req=ScanRequest(conditions=[leaf(kind, timeframe="D", include_open_bar=False)]), now=now)
    assert legacy.rows and [r.code for r in legacy.rows] == [r.code for r in selected.rows]
    assert sorted(e.date for e in legacy.rows[0].occurrences) == sorted(
        e.date for e in selected.rows[0].occurrences)


async def test_intraday_daily_ohlc_overlay_replaces_current_bar(corpus):
    condition = leaf(timeframe="W", period=2)
    overlay = pl.DataFrame({"code": ["005930"], "date": [dt.date(2026, 7, 28)], "volume": [900],
                            "open": [90.0], "high": [200.0], "low": [70.0], "close": [80.0]})
    result = await bars.evaluate(data_dir=corpus, conditions=[condition], codes=["005930"], basis="intraday",
        now=dt.datetime(2026, 7, 28, 10, tzinfo=KST), overlay=overlay)
    match = result.events[condition.id][0][1].bar_price_match
    assert match.value == 200 and match.is_open


async def test_failed_factor_pair_is_not_cached_and_retries(tmp_path, monkeypatch):
    prices._FACTORS.clear()
    calls = []

    async def fail(*args, **kwargs):
        calls.append(True)
        raise RuntimeError("provider unavailable")

    monkeypatch.setattr(prices.kiwoom_adjust_factors, "fetch_adjust_factors", fail)
    monkeypatch.setattr(prices.kiwoom_rest_runtime, "ensure_rest_client", lambda _: object())
    monkeypatch.setattr(prices.kiwoom_rest_runtime, "ensure_scheduler", lambda _: object())
    data = [replace(series([200])[0], start_ms=stamp("2026-07-29"))]
    for _ in range(2):
        adjusted, reason = await prices.adjusted_minutes(tmp_path, "005930", data, "20260730")
        assert reason == "adjustment_unavailable" and not adjusted[0].valid
    assert len(calls) == 2 and not prices._FLIGHTS and not prices._FACTORS


async def test_today_only_price_window_needs_no_historical_factors(tmp_path, monkeypatch):
    data = [replace(series([200])[0], start_ms=stamp("2026-07-29")), *series([110, 120])]

    async def cached(*args, **kwargs):
        return bars.MinuteSnapshot(data, 1)

    async def forbidden(*args, **kwargs):
        raise AssertionError("현재 봉 비교에 필요 없는 과거 수정계수를 조회했습니다")

    monkeypatch.setattr(bars, "minute_snapshot", cached)
    monkeypatch.setattr(prices, "_load_factors", forbidden)
    result = await bars.evaluate(data_dir=tmp_path, conditions=[leaf(timeframe="5m", period=2)],
        codes=["005930"], basis="intraday", now=dt.datetime(2026, 7, 30, 10, 7, tzinfo=KST))
    assert result.coverage.complete == 1
    assert result.events["new_high_today"][0][1].bar_price_match.reference == 120
