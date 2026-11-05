from __future__ import annotations

import asyncio
import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import kiwoom_rest_runtime, live_calendar_candle_backfill as calendar_module
from hoga.live.api import build_router
from hoga.live.kiwoom_calendar_candles import API_IDS, period_bounds
from hoga.live.kiwoom_daily_candles import parse_row
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.live_calendar_candle_backfill import LiveCalendarCandleBackfill

TODAY = date(2026, 11, 5)


def row(day, close=105, amount="123456789"):
    return {
        "dt": day,
        "open_pric": "100",
        "high_pric": "110",
        "low_pric": "90",
        "cur_prc": str(close),
        "trde_qty": "1000",
        "trde_prica": amount,
    }


class Provider:
    def get_token(self):
        return "mock"


class Scheduler:
    def __init__(self):
        self.calls = []

    async def submit(self, *, key, api_id, priority, call):
        self.calls.append((api_id, priority, key))
        return await call(None)


@pytest.fixture
async def harness(tmp_path, monkeypatch):
    h = SimpleNamespace(calls=[], pages={}, error=False, daily_calls=[], gate=None)

    async def handler(request):
        body = json.loads(request.content)
        api_id = request.headers["api-id"]
        cursor = request.headers.get("next-key", "")
        h.calls.append((api_id, body, cursor))
        if h.gate is not None:
            await h.gate.wait()
        if h.error:
            return httpx.Response(429, json={"return_code": 5, "return_msg": "rate limit"})
        rows, next_key = h.pages.get((api_id, body["stk_cd"], cursor), ([], ""))
        wrapper = "stk_stk_pole_chart_qry" if api_id == "ka10082" else "stk_mth_pole_chart_qry"
        return httpx.Response(
            200,
            json={"return_code": 0, wrapper: rows},
            headers={"cont-yn": "Y" if next_key else "N", "next-key": next_key},
        )

    client = KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_: client)
    h.scheduler = Scheduler()

    async def daily(**kwargs):
        h.daily_calls.append(kwargs)
        return {
            "candles": [
                parse_row(row("20261019", close=101), from_yyyymmdd="20261019", to_yyyymmdd="20261021")[0].model_dump(),
                parse_row(row("20261021", close=102), from_yyyymmdd="20261019", to_yyyymmdd="20261021")[0].model_dump(),
            ],
            "data_warnings": [],
        }

    h.service = LiveCalendarCandleBackfill(
        data_dir=tmp_path,
        scheduler=h.scheduler,
        daily_backfill=SimpleNamespace(collect_daily=daily, collect_daily_cache_only=daily),
    )
    h.client = client
    yield h
    await client.aclose()


async def collect(h, *, tf="W", frm=date(2026, 10, 19), too=TODAY, today=TODAY, venue="KRX", cache_only=False):
    return await h.service.collect(
        code="005930", frm=frm, too=too, today=today, venue=venue, timeframe=tf, cache_only=cache_only
    )


def weekly(h):
    h.pages[("ka10082", "005930", "")] = ([row(d) for d in ["20261102", "20261026", "20261019", "20261012"]], "")


@pytest.mark.parametrize(("tf", "days"), [("W", ["20261102", "20261026"]), ("M", ["20261102", "20261001"])])
async def test_native_tr_units_basis_and_venue(harness, tf, days):
    h = harness
    h.pages[(API_IDS[tf], "005930_NX", "")] = ([row(d, amount="123456789") for d in days], "")
    result = await collect(h, tf=tf, frm=date(2026, 10, 26) if tf == "W" else date(2026, 10, 1), venue="NXT")
    assert result["timeframe"] == tf
    assert all(c["trade_value_won"] == 123456789 for c in result["candles"])
    assert h.calls == [(API_IDS[tf], {"stk_cd": "005930_NX", "base_dt": "20261105", "upd_stkpc_tp": "1"}, "")]
    assert h.daily_calls == []
    assert h.scheduler.calls[0][:2] == (API_IDS[tf], "user_visible")


async def test_continuation_dedupe_and_retained_overshoot_avoid_new_left_fetch(harness):
    h = harness
    h.pages[("ka10082", "005930", "")] = ([row("20261102"), row("20261026")], "page2")
    h.pages[("ka10082", "005930", "page2")] = ([row("20261026"), row("20261019"), row("20261012")], "page3")
    result = await collect(h)
    assert len(result["candles"]) == 3
    assert len(h.calls) == 2
    assert h.calls[-1][2] == "page2"
    extended = await collect(h, frm=date(2026, 10, 12))
    assert len(extended["candles"]) == 4
    assert len(h.calls) == 2
    assert extended["fresh_batches"] == []
    assert extended["data_warnings"] == []


async def test_current_refresh_reads_first_page_only_and_keeps_history(harness, monkeypatch):
    h = harness
    now = [100.0]
    monkeypatch.setattr(calendar_module, "monotonic", lambda: now[0])
    weekly(h)
    await collect(h)
    now[0] += 61
    h.pages[("ka10082", "005930", "")] = ([row("20261102", close=109), row("20261026")], "unused")
    refreshed = await collect(h)
    assert len(h.calls) == 2
    assert len(refreshed["candles"]) == 3
    assert refreshed["candles"][-1]["close"] == 109


async def test_new_adjustment_day_and_timeframe_have_separate_cache(harness):
    h = harness
    weekly(h)
    await collect(h)
    await collect(h, today=date(2026, 11, 6), too=date(2026, 11, 6))
    await collect(h, tf="M", frm=date(2026, 10, 1))
    assert [c[0] for c in h.calls] == ["ka10082", "ka10082", "ka10083"]
    assert h.calls[1][1]["base_dt"] == "20261106"


async def test_historical_cutoff_uses_daily_only_for_the_boundary(harness):
    h = harness
    weekly(h)
    result = await collect(h, frm=date(2026, 10, 12), too=date(2026, 10, 21))
    assert [c["close"] for c in result["candles"]] == [105, 102]
    assert result["candles"][-1]["volume"] == 2000
    assert h.daily_calls[0]["frm"] == date(2026, 10, 19)
    assert h.daily_calls[0]["too"] == date(2026, 10, 21)


async def test_same_partial_period_does_not_fetch_native_future_values(harness):
    h = harness
    weekly(h)
    result = await collect(h, frm=date(2026, 10, 20), too=date(2026, 10, 21))
    assert len(result["candles"]) == 1
    assert h.calls == []
    assert result["candles"][0]["close"] == 102


async def test_error_retains_good_bars_and_does_not_poison_cache(harness):
    h = harness
    weekly(h)
    await collect(h)
    h.error = True
    result = await collect(h, frm=date(2026, 10, 5))
    assert len(result["candles"]) == 4
    assert result["data_warnings"][0]["reason"] == "rate_limit_upstream"
    h.error = False
    await collect(h, frm=date(2026, 10, 5))
    assert len(h.calls) == 3


async def test_concurrent_same_code_shares_completed_walk(harness):
    h = harness
    weekly(h)
    a, b = await asyncio.gather(collect(h), collect(h))
    assert a["candles"] == b["candles"]
    assert len(h.calls) == 1


async def test_empty_result_is_cached_and_bypass_never_calls_vendor(harness):
    h = harness
    await collect(h)
    await collect(h)
    assert len(h.calls) == 1
    result = await collect(h, frm=date(2026, 10, 5), cache_only=True)
    assert len(h.calls) == 1
    assert result["data_warnings"][0]["reason"] == "rest_bypassed"


async def test_fallback_merges_by_period_when_venues_have_different_first_trade(harness):
    h = harness
    weekly(h)
    h.pages[("ka10082", "005930_NX", "")] = ([row("20261103", close=109)], "")
    result = await collect(h, venue="NXT")
    assert len(result["candles"]) == 3
    assert result["candles"][-1]["close"] == 109
    assert len({period_bounds(date.fromtimestamp(c["t_ms"] / 1000), "W")[0] for c in result["candles"]}) == 3
    assert result["data_warnings"][0]["is_failure"] is False


async def test_invalid_rows_warn_and_retry_instead_of_claiming_coverage(harness):
    h = harness
    h.pages[("ka10082", "005930", "")] = ([row("20261102"), row("20261032")], "")
    result = await collect(h)
    assert result["data_warnings"][0]["reason"] == "invariant_violation"
    await collect(h)
    assert len(h.calls) == 2


def test_committed_vendor_examples_preserve_native_money_and_adjusted_volume():
    examples = json.loads(
        (Path(__file__).parents[2] / "fixtures/kiwoom_rest/native_calendar_examples.json").read_text()
    )
    for e in examples["examples"]:
        c, violation = parse_row(
            e["native_wire_row"], from_yyyymmdd="19000101", to_yyyymmdd="20261105", trade_value_unit_won=1
        )
        assert violation is None
        assert c.trade_value_won == int(e["period_result"]["fields"]["trade_value_won"]["native"])
        assert c.volume == int(e["period_result"]["fields"]["volume"]["native"])


def test_calendar_http_contract_and_validation(tmp_path, monkeypatch):
    from hoga.live import api, lifecycle

    scheduler = Scheduler()
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: scheduler)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_: object())
    monkeypatch.setattr(api, "_today_kst_date", lambda: TODAY)

    async def collect_mock(self, **kwargs):
        return {
            "code": kwargs["code"],
            "from": "20261001",
            "to": "20261105",
            "timeframe": kwargs["timeframe"],
            "venue": kwargs["venue"],
            "candles": [{"t_ms": 1, "open": 1, "high": 2, "low": 1, "close": 2, "volume": 3, "trade_value_won": 7}],
            "cached_batches": [],
            "fresh_batches": [],
            "data_warnings": [],
        }

    monkeypatch.setattr(LiveCalendarCandleBackfill, "collect", collect_mock)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    with TestClient(app) as client:
        url = "/api/live/past-calendar-candles?code=005930&from=20261001&to=20261105"
        result = client.get(url + "&timeframe=W&venue=UN")
        assert result.status_code == 200
        assert result.json()["timeframe"] == "W"
        assert result.json()["candles"][0]["trade_value_won"] == 7
        assert result.json()["from"] == "20261001"
        assert client.get(url + "&timeframe=D").status_code == 422
        assert client.get(url + "&timeframe=M&venue=invalid").status_code == 422


async def test_http_request_reaches_actual_native_adapter_and_preserves_wire_fields(harness, tmp_path, monkeypatch):
    from hoga.live import api, lifecycle

    h = harness
    weekly(h)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda *_: h.scheduler)
    monkeypatch.setattr(api, "_today_kst_date", lambda: TODAY)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/api/live/past-calendar-candles?code=005930&from=20261019&to=20261105&timeframe=W")
        assert response.status_code == 200
        assert response.json()["timeframe"] == "W"
        assert response.json()["candles"][-1]["trade_value_won"] == 123456789
        assert h.calls[0][0] == "ka10082"
        assert h.calls[0][1]["upd_stkpc_tp"] == "1"
        await client.get("/api/live/past-calendar-candles?code=005930&from=20261012&to=20261105&timeframe=W")
        assert len(h.calls) == 1


async def test_cancelled_walk_releases_lock_for_the_next_request(harness):
    h = harness
    weekly(h)
    h.gate = asyncio.Event()
    task = asyncio.create_task(collect(h))
    while not h.calls:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    h.gate.set()
    result = await collect(h)
    assert len(result["candles"]) == 3


async def test_page_cap_surfaces_warning_instead_of_complete_coverage(harness, monkeypatch):
    from hoga.live import kiwoom_calendar_candles

    h = harness
    monkeypatch.setattr(kiwoom_calendar_candles, "_MAX_PAGES", 1)
    h.pages[("ka10082", "005930", "")] = ([row("20261102")], "unfinished")
    result = await collect(h)
    assert result["data_warnings"][0]["reason"] == "invariant_violation"
    assert "truncated" in result["data_warnings"][0]["msg"]
    await collect(h)
    assert len(h.calls) == 2


async def test_whitespace_only_native_row_is_empty_and_allows_venue_fallback(harness):
    h = harness
    weekly(h)
    h.pages[("ka10082", "005930_NX", "")] = ([{k: "   " for k in row("20261102")}], "")
    result = await collect(h, venue="NXT")
    assert len(result["candles"]) == 3
    assert all(not w["is_failure"] for w in result["data_warnings"])


async def test_corrupt_current_row_keeps_last_good_forming_bar_with_warning(harness, monkeypatch):
    h = harness
    weekly(h)
    now = [100.0]
    monkeypatch.setattr(calendar_module, "monotonic", lambda: now[0])
    await collect(h)
    now[0] += 61
    h.pages[("ka10082", "005930", "")] = ([{**row("20261102"), "cur_prc": ""}, row("20261026")], "")
    result = await collect(h)
    assert result["candles"][-1]["close"] == 105
    assert result["data_warnings"][0]["reason"] == "invariant_violation"


@pytest.mark.parametrize("timeframe", ["W", "M"])
async def test_native_pages_run_through_real_capacity_scheduler(harness, timeframe):
    from hoga.live.kiwoom_capacity import KiwoomCapacityScheduler

    h = harness
    api_id = API_IDS[timeframe]
    h.pages[(api_id, "005930", "")] = ([row("20261102"), row("20260901")], "")
    scheduler = KiwoomCapacityScheduler(workers=1, background_workers=1)
    scheduler.set_clients([h.client])
    h.service._scheduler = scheduler
    try:
        result = await collect(h, tf=timeframe, frm=date(2026, 10, 1))
        assert result["data_warnings"] == []
        assert result["candles"][0]["close"] == 105
        assert h.calls[0][0] == api_id
    finally:
        await scheduler.aclose()
