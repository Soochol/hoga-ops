import json
from datetime import date
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import kiwoom_rest_runtime, lifecycle
from hoga.live.api import batched_daily_walkback, build_router
from hoga.live.candle_models import daily_anchor_ms
from hoga.live.daily_program_trade import DailyProgramTradeBackfill, fetch_daily_program_trade
from hoga.live.kiwoom_errors import KiwoomApiError
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


class Provider:
    def get_token(self):
        return "test-token"


class Scheduler:
    def __init__(self):
        self.calls = []

    async def submit(self, **kw):
        self.calls.append((kw["api_id"], kw["key"]))
        return await kw["call"](None)


def vendor_client(handler):
    return KiwoomRestClient(Provider(), transport=httpx.MockTransport(handler))


def response(rows, *, more=False):
    return httpx.Response(200, json={"return_code": 0, "stk_daly_prm_trde_trnsn": rows},
                          headers={"cont-yn": "Y" if more else "N", "next-key": "next" if more else ""})


def row(day, *, net="-30", buy="100", sell="130"):
    return {"dt": day, "prm_netprps_qty": net, "prm_buy_qty": buy, "prm_sell_qty": sell,
            "prm_buy_amt": "999999"}


async def test_cursor_pages_go_through_scheduler_and_cache_all_sides(tmp_path, monkeypatch):
    requests = []

    def handler(request):
        requests.append(request)
        assert request.url.path == "/api/dostk/stkinfo"
        assert request.headers["api-id"] == "ka90013"
        assert json.loads(request.content) == {"stk_cd": "005930", "date": "20260106", "amt_qty_tp": "2"}
        if len(requests) == 1:
            return response([row("20260106")], more=True)
        assert request.headers["next-key"] == "next"
        return response([row("20260105", net="20", buy="150"), row("20260104")])

    client = vendor_client(handler)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda _: client)
    scheduler = Scheduler()
    backfill = DailyProgramTradeBackfill(data_dir=tmp_path, cache=PastDailyCandlesCache(),
                                         scheduler=scheduler, walkback=batched_daily_walkback)
    args = dict(code="005930", frm=date(2026, 1, 5), too=date(2026, 1, 6), today_d=date(2026, 1, 7))
    first = await backfill.collect(**args)
    second = await backfill.collect(**args)
    assert first["points"] == second["points"] == [
        {"t_ms": daily_anchor_ms("20260105"), "net_qty": 20, "buy_qty": 150, "sell_qty": 130},
        {"t_ms": daily_anchor_ms("20260106"), "net_qty": -30, "buy_qty": 100, "sell_qty": 130},
    ]
    assert len(scheduler.calls) == len(requests) == 2
    assert scheduler.calls[0][1] != scheduler.calls[1][1]
    assert second["cached_batches"]


async def test_null_is_not_zero_and_invalid_dates_are_reported():
    client = vendor_client(lambda _: response([
        row("20260105", net="0", buy="", sell="-130"), row("20260230"), row("20260105"),
    ]))
    async def run_page(fetch, _idx):
        return await fetch(client)
    points, warnings, _ = await fetch_daily_program_trade(client, "005930", "20260101", "20260301", run_page=run_page)
    assert points == [{"t_ms": daily_anchor_ms("20260105"), "net_qty": 0, "buy_qty": None, "sell_qty": 130}]
    assert len(warnings) == 2


async def test_truncation_is_not_cached_as_a_complete_range():
    client = AsyncMock()
    client.walk.return_value = ([row("20260105")], True)
    with pytest.raises(KiwoomApiError, match="연속 조회"):
        await fetch_daily_program_trade(client, "005930", "20200101", "20260105", run_page=AsyncMock())


def test_http_wire_cache_and_validation(tmp_path, monkeypatch):
    client = vendor_client(lambda _: response([row("20260105", buy="")]))
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda _: client)
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda _: Scheduler())
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    with TestClient(app) as http:
        url = "/api/live/daily-program-trade?code=005930&from=20260105&to=20260105"
        first = http.get(url)
        assert first.status_code == 200
        body = first.json()
        assert body["from"] == body["to"] == "20260105"
        assert body["points"][0] == {
            "t_ms": daily_anchor_ms("20260105"), "net_qty": -30, "buy_qty": None, "sell_qty": 130,
        }
        assert body["data_warnings"]
        warm = http.get(url).json()
        assert warm["cached_batches"] and warm["data_warnings"]
        assert http.get(url.replace("005930", "bad")).status_code == 422
        assert http.get(url.replace("to=20260105", "to=20260101")).status_code == 422


def test_unwired_endpoint_is_explicit():
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    with TestClient(app) as http:
        assert http.get("/api/live/daily-program-trade?code=005930&from=20260105&to=20260105").status_code == 503
