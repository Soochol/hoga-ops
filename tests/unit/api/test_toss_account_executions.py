from __future__ import annotations

from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_v2_routes import build_router
from hoga.trading.multi_broker import BrokerTradingService
from hoga.trading.service import TradingService
from hoga.trading.toss import TossClient
from hoga.util.timeenc import KST

DATE = "20261019"


def order(native="buy", *, side="BUY", quantity="30", price="72300.25", filled_at="2026-10-19T09:08:42+09:00", **patch):
    return {"orderId": native, "symbol": "005930", "currency": "KRW", "side": side,
            "orderType": "LIMIT", "timeInForce": "DAY", "status": "FILLED", "quantity": "100",
            "price": "73000", "orderedAt": "2026-10-18T18:00:00+09:00",
            "execution": {"filledQuantity": quantity, "averageFilledPrice": price, "filledAt": filled_at}, **patch}


@pytest.fixture
async def toss_history(tmp_path, monkeypatch):
    calls = []
    pages = {"": {"orders": [order(), order("canceled", side="SELL", quantity="5", status="CANCELED"),
                              order("unfilled", quantity="0", price=None, filled_at=None)],
                   "hasNext": True, "nextCursor": "second"},
             "second": {"orders": [order("buy", quantity="10", price="72000"), order("next", quantity="1")],
                        "hasNext": False, "nextCursor": None},
             "OPEN": {"orders": [order("partial", quantity="2", status="PARTIAL_FILLED")],
                      "hasNext": False, "nextCursor": None}}

    async def handle(request):
        calls.append(request)
        assert request.url.host == "openapi.tossinvest.com"
        if request.url.path == "/oauth2/token":
            return httpx.Response(200, json={"access_token": "fixture", "expires_in": 3600})
        assert request.method == "GET"
        if request.url.path == "/api/v1/accounts":
            return httpx.Response(200, json={"result": [
                {"accountSeq": 7, "accountNo": "1234567890", "accountType": "BROKERAGE"}]})
        assert request.url.path == "/api/v1/orders"
        assert request.headers["X-Tossinvest-Account"] == "7"
        params = request.url.params
        assert params["symbol"] == "005930"
        # Both filters refer to orderedAt and would lose earlier orders filled on the chart date.
        assert "from" not in params and "to" not in params
        key = "OPEN" if params["status"] == "OPEN" else params.get("cursor", "")
        if key != "OPEN":
            assert params["limit"] == "100"
        return httpx.Response(200, json={"result": pages[key]})

    async def pace(*_args):
        pass

    client = TossClient("fixture", "fixture", transport=httpx.MockTransport(handle))
    monkeypatch.setattr(client, "_pace", pace)
    legacy = TradingService(tmp_path, client=client)
    service = BrokerTradingService(tmp_path, legacy, kiwoom=[])
    ref = (await service.accounts()).accounts[0].account_ref

    async def raw_close(code, date, venue):
        assert (code, date) == ("005930", DATE)
        assert venue in {"KRX", "NXT", "UN"}
        return "74000"

    monkeypatch.setattr(service.toss_execution_history, "quote_original_close", raw_close)
    app = FastAPI()
    app.include_router(build_router(service))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
        yield api, service, ref, calls, pages
    await service.close()
    await legacy.close()


async def test_order_averages_last_fill_time_partial_cancel_pagination_and_scope(toss_history):
    api, service, ref, calls, _ = toss_history
    params = {"account_ref": ref, "code": "005930", "date": DATE}
    first = await api.get("/api/trading/v2/executions", params=params)
    assert first.status_code == 200
    body = first.json()
    assert body["supported"] is True and body["message"] is None
    assert body["raw_close"] == "74000"
    assert len(body["rows"]) == 3
    assert all(r["basis"] == "order_average" and r["venue"] is None for r in body["rows"])
    assert sorted(r["quantity"] for r in body["rows"]) == ["2", "30", "5"]
    buy = next(r for r in body["rows"] if r["quantity"] == "30")
    assert buy["price"] == "72300.25"  # Fractional weighted averages are not rounded to a tick.
    assert buy["t_ms"] == int(datetime(2026, 10, 19, 9, 8, 42, tzinfo=KST).timestamp() * 1000)
    assert buy["trading_date"] == DATE
    assert buy["order_ref"].startswith("ord_")
    assert "buy" not in body["next_cursor"] and "second" not in body["next_cursor"]
    again = await api.get("/api/trading/v2/executions", params=params)
    assert again.json() == body
    assert len([r for r in calls if r.url.path == "/api/v1/orders"]) == 2
    second = await api.get("/api/trading/v2/executions", params={**params, "cursor": body["next_cursor"]})
    assert second.status_code == 200 and second.json()["next_cursor"] is None
    assert len(second.json()["rows"]) == 2
    for patch in ({"date": "20261020"}, {"code": "000660"}, {"venue": "UN"}):
        response = await api.get("/api/trading/v2/executions",
                                 params={**params, "cursor": body["next_cursor"], **patch})
        assert response.status_code == 422
    unauthorized = await api.get("/api/trading/v2/executions", params={**params, "account_ref": "acc_" + "0" * 32})
    assert unauthorized.status_code == 403
    # All visible dates and venues reuse source order pages (no N visible dates × N upstream scans).
    other = await api.get("/api/trading/v2/executions", params={**params, "date": "20261018"})
    assert other.status_code == 200 and other.json()["rows"] == []
    assert len([r for r in calls if r.url.path == "/api/v1/orders"]) == 3
    assert not service.toss_execution_history.path.exists()  # Mutable summaries aren't fill archives.


async def test_summary_updates_in_place_and_moves_to_latest_fill_date(toss_history):
    api, service, ref, _, pages = toss_history
    params = {"account_ref": ref, "code": "005930", "date": DATE}
    pages[""] = {"orders": [order()], "hasNext": False, "nextCursor": None}
    pages["OPEN"]["orders"] = []
    original = (await api.get("/api/trading/v2/executions", params=params)).json()["rows"][0]
    pages[""]["orders"] = [order(quantity="40", price="72400.5", filled_at="2026-10-19T09:17:02+09:00")]
    service.toss_execution_history.cache.clear()
    service.toss_execution_history.sources.clear()
    updated = (await api.get("/api/trading/v2/executions", params=params)).json()["rows"]
    assert len(updated) == 1 and updated[0]["execution_id"] == original["execution_id"]
    assert updated[0]["order_ref"] == original["order_ref"]
    assert updated[0]["price"] == "72400.5" and updated[0]["quantity"] == "40"
    assert updated[0]["t_ms"] > original["t_ms"]
    pages[""]["orders"][0]["execution"]["filledAt"] = "2026-10-20T09:00:00+09:00"
    service.toss_execution_history.cache.clear()
    service.toss_execution_history.sources.clear()
    assert (await api.get("/api/trading/v2/executions", params=params)).json()["rows"] == []


@pytest.mark.parametrize("patch", [
    {"execution": {"filledQuantity": "1"}},  # Don't substitute order time or order price.
    {"execution": {"filledQuantity": "NaN"}},
    {"execution": {"filledQuantity": "-1"}},
    {"execution": {"filledQuantity": "1", "averageFilledPrice": "Infinity", "filledAt": "2026-10-19T09:00:00+09:00"}},
    {"execution": {"filledQuantity": "1", "averageFilledPrice": "72300", "filledAt": "2026-10-19T09:00:00"}},
    {"symbol": "000660"}, {"currency": "USD"},
])
async def test_malformed_or_foreign_summary_never_becomes_a_marker(toss_history, patch):
    api, _, ref, _, pages = toss_history
    pages[""]["orders"] = [order(**patch)]
    response = await api.get("/api/trading/v2/executions", params={"account_ref": ref, "code": "005930", "date": DATE})
    assert response.status_code == 503


async def test_rejects_broken_order_pagination(toss_history):
    api, _, ref, _, pages = toss_history
    pages[""]["nextCursor"] = None
    response = await api.get("/api/trading/v2/executions", params={"account_ref": ref, "code": "005930", "date": DATE})
    assert response.status_code == 503


async def test_daily_basis_uses_same_chart_venue_and_existing_quote_governor(tmp_path, monkeypatch):
    from hoga.trading.toss_executions import TossExecutionHistory

    history = TossExecutionHistory(tmp_path)
    client = object()
    scheduler = object()
    monkeypatch.setattr("hoga.trading.toss_executions.kiwoom_rest_runtime.ensure_rest_client", lambda _: client)
    monkeypatch.setattr("hoga.trading.toss_executions.kiwoom_rest_runtime.ensure_scheduler", lambda _: scheduler)
    monkeypatch.setattr("hoga.trading.toss_executions.settings.rest_bypass_enabled", lambda _: False)

    async def call(api_id, body):
        assert api_id == "ka10081"
        assert body == {"stk_cd": "005930_NX", "base_dt": DATE, "upd_stkpc_tp": "0"}
        return SimpleNamespace(rows=[{"dt": "20261018", "cur_prc": "72000"}, {"dt": DATE, "cur_prc": "-74000"}])

    async def capacity(actual, **kwargs):
        assert actual is scheduler and kwargs["client"] is client
        assert kwargs["priority"] == "user_visible" and kwargs["api_id"] == "ka10081"
        return await kwargs["fetch_fn"](SimpleNamespace(call=call))

    monkeypatch.setattr("hoga.trading.toss_executions.kiwoom_access.run_with_capacity", capacity)
    assert await history.quote_original_close("005930", DATE, "NXT") == "74000"
    monkeypatch.setattr("hoga.trading.toss_executions.settings.rest_bypass_enabled", lambda _: True)
    assert await history.quote_original_close("005930", DATE, "NXT") is None
