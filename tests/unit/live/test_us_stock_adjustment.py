"""US adjusted history must keep a single vendor anchor across viewport ranges."""
from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live.kiwoom_rest import Page
from hoga.live.kiwoom_us_daily_candles import StockDailyWalk, fetch_stock_daily
from hoga.live.us_daily_candles import NY, UsDateRange
from hoga.live.us_market_api import UsMarketApi
from hoga.live.us_stock_minutes import StockMinuteWindow, UsStockMinuteService, parse_stock_minute


def daily_row(day, price):
    return dict(dt=day, open_pric=str(price), high_pric=str(price), low_pric=str(price),
                cur_prc=str(price), acc_trde_qty="100")


def page(rows, cursor=""):
    return Page(rows=rows, cont=bool(cursor), next_key=cursor,
                raw={"return_code": 0, "result_list": rows})


async def governed(_scheduler, *, client, fetch_fn, **kwargs):
    return await fetch_fn(client)


@pytest.mark.asyncio
async def test_split_boundary_viewports_reuse_current_anchor_and_cursor(monkeypatch):
    calls = []

    async def call(api, body, *, cont, next_key):
        calls.append((body.copy(), next_key))
        # Same behavior measured for NVDA: a pre-split strt_dt would return 1208.88.
        if next_key:
            return page([daily_row("20240607", 120.888 if body["strt_dt"] >= "20240610" else 1208.88)])
        return page([daily_row("20240610", 121.79)], "before-split")

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", governed)
    client = SimpleNamespace(call=call)
    walk = StockDailyWalk("20240611")
    recent = await fetch_stock_daily(client, None, "NASDAQ", "NVDA", "20240610", "20240610",
                                     adjusted_as_of="20240611", walk=walk)
    older = await fetch_stock_daily(client, None, "NASDAQ", "NVDA", "20240607", "20240607",
                                    adjusted_as_of="20240611", walk=walk)
    assert recent.bars[0].close == 121.79 and older.bars[0].close == 120.888
    assert [c[1] for c in calls] == ["", "before-split"]
    assert all(b["strt_dt"] == "20240611" and b["upd_stkpc_tp"] == "1" for b, _ in calls)
    assert older.completed == [UsDateRange(start="20240607", end="20240607")]
    assert not older.truncated


@pytest.mark.asyncio
async def test_deep_date_jump_resumes_bounded_walk_without_false_coverage(monkeypatch):
    calls = []

    async def call(api, body, *, cont, next_key):
        calls.append(next_key)
        return (page([daily_row("20240610", 121)], "older") if not cont
                else page([daily_row("20240607", 120.888)]))

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", governed)
    client = SimpleNamespace(call=call)
    walk = StockDailyWalk("20240611")
    options = dict(adjusted_as_of="20240611", walk=walk, max_pages=1)
    first = await fetch_stock_daily(client, None, "NASDAQ", "NVDA", "20240601", "20240607", **options)
    assert first.truncated and not first.bars and not first.completed
    second = await fetch_stock_daily(client, None, "NASDAQ", "NVDA", "20240601", "20240607", **options)
    assert calls == ["", "older"]
    assert not second.truncated and second.bars[0].close == 120.888
    assert second.completed == [UsDateRange(start="20240601", end="20240607")]


@pytest.mark.asyncio
async def test_bad_page_does_not_commit_adjusted_rows_or_cursor(monkeypatch):
    async def call(*args, **kwargs):
        return page([daily_row("20240607", 120.888), daily_row("20240607", 1208.88)], "bad")

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", governed)
    walk = StockDailyWalk("20240611")
    result = await fetch_stock_daily(SimpleNamespace(call=call), None, "NASDAQ", "NVDA",
                                    "20240601", "20240607", adjusted_as_of="20240611", walk=walk)
    assert result.messages and not result.bars and not result.completed and not walk.checkpoints


@pytest.mark.parametrize("timeframe", ["D", "W", "M"])
def test_http_rollover_rebuilds_entire_adjusted_history_including_calendar_bars(tmp_path, monkeypatch, timeframe):
    now = [datetime(2024, 6, 10, 12, tzinfo=NY)]
    requests = []

    async def call(api, body, *, cont, next_key):
        requests.append(body.copy())
        price = 1208.88 if body["strt_dt"] == "20240610" else 120.888
        return page([daily_row("20240607", price)])

    client = SimpleNamespace(call=call)
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda _: client)
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_scheduler", lambda _: None)
    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", governed)
    api = UsMarketApi(tmp_path)
    api.daily.calendar_now = lambda: now[0]
    app = FastAPI()
    app.include_router(api.router, prefix="/api/live")
    with TestClient(app) as http:
        params = dict(exchange="NASDAQ", symbol="GOOGL", timeframe=timeframe, **{"from": "20240607", "to": "20240607"})
        old = http.get("/api/live/us-stock-daily-candles", params=params).json()
        assert old["daily_metadata"]["price_basis"] == "adjusted"
        assert old["daily_metadata"]["adjusted_as_of"] == "20240610"
        assert old["candles"][0]["close"] == 1208.88
        now[0] = datetime(2024, 6, 11, 0, 1, tzinfo=NY)
        new = http.get("/api/live/us-stock-daily-candles", params=params).json()
        assert new["daily_metadata"]["adjusted_as_of"] == "20240611"
        assert new["candles"][0]["close"] == 120.888
        assert [r["strt_dt"] for r in requests] == ["20240610", "20240611"]


@pytest.mark.asyncio
async def test_minute_rollover_rejects_old_cursor_and_never_retains_old_basis_on_error(monkeypatch):
    now = [datetime(2026, 10, 18, tzinfo=NY)]
    fail = [False]

    async def fetch(*args, **kwargs):
        bar = parse_stock_minute(dict(bus_dt="20261016", cntr_tm="20261016185500",
            open_pric="100", high_pric="100", low_pric="100", cur_prc="100", trde_qty="5"))
        return StockMinuteWindow(bars=[] if fail[0] else [bar], pages=1, more=True,
                                 cursor="vendor", failed=fail[0], messages=["offline"] if fail[0] else [])

    monkeypatch.setattr("hoga.live.us_stock_minutes.fetch_stock_minutes", fetch)
    service = UsStockMinuteService(calendar_now=lambda: now[0])
    old, meta = await service.get("NASDAQ", "GOOGL", "60m", client=object())
    assert old and meta.adjusted_as_of == "20261018" and meta.price_basis == "adjusted"
    now[0] = datetime(2026, 10, 19, tzinfo=NY)
    fail[0] = True
    rows, new_meta = await service.get("NASDAQ", "GOOGL", "60m", client=object())
    assert not rows and new_meta.refresh_status == "error" and new_meta.adjusted_as_of == "20261019"
    with pytest.raises(ValueError, match="기준일"):
        await service.get("NASDAQ", "GOOGL", "60m", client=object(), cursor=meta.next_cursor)
    await service.aclose()


@pytest.mark.asyncio
async def test_provisional_anchor_ohlc_cannot_block_completed_history(monkeypatch):
    async def call(*args, **kwargs):
        # Real GOOGL premarket shape: current price has moved while daily H/L
        # still equal the previous close. It is not a completed-history candle.
        current = {**daily_row("20261030", 283.82), "cur_prc": "281.75"}
        return page([current, daily_row("20261029", 283.82)])

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", governed)
    client = SimpleNamespace(call=call)
    result = await fetch_stock_daily(client, None, "NASDAQ", "GOOGL", "20261001", "20261029",
                                     adjusted_as_of="20261030")
    assert not result.messages and not result.truncated
    assert [b.trading_date for b in result.bars] == ["20261029"]
    assert result.completed == [UsDateRange(start="20261001", end="20261029")]
    # A provisional endpoint must still reject its own invalid OHLC.
    current = await fetch_stock_daily(client, None, "NASDAQ", "GOOGL", "20261030", "20261030",
                                      adjusted_as_of="20261030")
    assert current.messages and not current.bars and not current.completed
