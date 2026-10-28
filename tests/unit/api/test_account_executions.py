from __future__ import annotations

import json
from datetime import datetime
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_v2_routes import build_router
from hoga.live.kiwoom_budget import KiwoomBudget
from hoga.trading.accounts import AccountRegistry
from hoga.trading.chart_executions import ExecutionHistory, parse_execution
from hoga.trading.kiwoom import KiwoomAccountGateway, KiwoomTradingAdapter
from hoga.trading.multi_broker import BrokerTradingService
from hoga.trading.service import TradingService
from hoga.util.timeenc import KST


def fill(number="0000001", **patch):
    return {"ord_no": "0000050", "cntr_no": number, "stk_cd": "A005930", "io_tp_nm": "현금매수",
            "cntr_qty": "0000000010", "cntr_uv": "0000072300", "cntr_tm": "09:08:12",
            "ord_tm": "08:59:00", "dmst_stex_tp": "KRX", **patch}


@pytest.fixture
async def history(tmp_path):
    requests = []
    pages = {"": ([fill(), fill(), fill("0000002", cntr_tm="09:08:42")], "second"),
             "second": ([fill("0000003", cntr_uv="0000072500", cntr_tm="09:17:06")], None)}

    async def handle(request):
        body = json.loads(request.content)
        api = request.headers["api-id"]
        requests.append((api, body, request.headers.get("next-key")))
        assert request.url.host == "api.kiwoom.com"
        if api == "ka00001":
            return httpx.Response(200, json={"return_code": 0, "acctNo": "1111111111"})
        if api == "ka10081":
            assert request.url.path == "/api/dostk/chart"
            assert body["upd_stkpc_tp"] == "0"
            return httpx.Response(200, json={"return_code": 0, "stk_dt_pole_chart_qry": [
                {"dt": body["base_dt"], "cur_prc": "-74000"}]})
        assert api == "kt00009"
        assert request.url.path == "/api/dostk/acnt"
        assert body["qry_tp"] == "1"
        assert body["ord_dt"] == "20261019"
        rows, next_key = pages[request.headers.get("next-key", "")]
        return httpx.Response(200, headers={"cont-yn": "Y" if next_key else "N", "next-key": next_key or ""},
                              json={"return_code": 0, "acnt_ord_cntr_prst_array": rows})

    provider = SimpleNamespace(_creds=SimpleNamespace(environment="real"), get_token=lambda: "fixture-token")
    gateway = KiwoomAccountGateway(provider, transport=httpx.MockTransport(handle), budget=KiwoomBudget(interval=0))
    adapter = KiwoomTradingAdapter(gateway, AccountRegistry(tmp_path / "trading/accounts.sqlite3"), tmp_path)
    legacy = TradingService(tmp_path)
    service = BrokerTradingService(tmp_path, legacy, kiwoom=[adapter])
    await service.accounts()
    app = FastAPI()
    app.include_router(build_router(service))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        yield client, adapter, service, requests, pages
    await service.close()
    await legacy.close()


async def test_http_preserves_individual_fills_and_cursor_scope_and_restart(history, tmp_path):
    api, adapter, service, requests, pages = history
    params = {"account_ref": adapter.account_ref, "code": "005930", "date": "20261019"}
    first = await api.get("/api/trading/v2/executions", params=params)
    assert first.status_code == 200
    body = first.json()
    assert body["price_venue"] == "KRX"
    assert body["raw_close"] == "74000"
    assert len(body["rows"]) == 2  # Same-price, same-order split fills survive. Repeated vendor row doesn't.
    assert body["rows"][0]["t_ms"] == int(datetime(2026, 10, 19, 9, 8, 12, tzinfo=KST).timestamp() * 1000)
    assert body["rows"][0]["price"] == "72300"
    assert body["rows"][0]["quantity"] == "10"
    assert body["rows"][0]["order_ref"].startswith("ord_")
    assert body["rows"][0]["t_ms"] != int(datetime(2026, 10, 19, 8, 59, tzinfo=KST).timestamp() * 1000)
    assert "second" not in body["next_cursor"]
    # Warm identical read shares the broker page, independently of chart timeframe.
    await api.get("/api/trading/v2/executions", params=params)
    assert sum(api == "kt00009" for api, _, _ in requests) == 1
    second = await api.get("/api/trading/v2/executions", params={**params, "cursor": body["next_cursor"]})
    assert second.status_code == 200
    assert second.json()["next_cursor"] is None
    assert second.json()["rows"][0]["price"] == "72500"
    for patch in ({"code": "000660"}, {"date": "20261020"}, {"venue": "UN"}):
        response = await api.get("/api/trading/v2/executions",
                                 params={**params, "cursor": body["next_cursor"], **patch})
        assert response.status_code == 422
    # A new process can recover confirmed fills when the vendor's retention window returns empty.
    service.execution_history = ExecutionHistory(tmp_path)
    pages[""] = ([], None)
    restored = await api.get("/api/trading/v2/executions", params=params)
    assert len(restored.json()["rows"]) == 3
    assert restored.json()["next_cursor"] is None


@pytest.mark.parametrize("patch", [
    {"cntr_tm": ""}, {"cntr_tm": "25:00:00"}, {"cntr_no": "0000000"}, {"cntr_uv": "0"},
    {"stk_cd": "A000660"}, {"acnt_no": "9999999999"}, {"cntr_qty": "-10"}, {"cntr_qty": None},
    {"io_tp_nm": "미확인"},
])
async def test_incomplete_or_foreign_identity_never_becomes_a_marker(history, patch):
    api, adapter, _, _, pages = history
    pages[""] = ([fill(**patch)], None)
    response = await api.get("/api/trading/v2/executions", params={
        "account_ref": adapter.account_ref, "code": "005930", "date": "20261019"})
    assert response.status_code == 503
    assert "9999999999" not in response.text


async def test_validation_empty_results_and_unfilled_remainders(history):
    api, adapter, _, requests, pages = history
    params = {"account_ref": adapter.account_ref, "code": "005930", "date": "20261019"}
    before = len(requests)
    for patch in ({"account_ref": "invalid"}, {"code": "00593"}, {"date": "20260230"}, {"date": "20990101"}):
        assert (await api.get("/api/trading/v2/executions", params={**params, **patch})).status_code == 422
    assert len(requests) == before
    pages[""] = ([fill(cntr_qty="0", cntr_no="", cntr_tm="", cntr_uv="")], None)
    body = (await api.get("/api/trading/v2/executions", params=params)).json()
    assert body["rows"] == []
    assert body["supported"] is True
    assert body["message"] is None
    assert body["raw_close"] is None


async def test_daily_price_basis_is_loaded_when_the_first_fill_arrives_on_a_later_page(history):
    api, adapter, _, requests, pages = history
    pages[""] = ([], "second")
    params = {"account_ref": adapter.account_ref, "code": "005930", "date": "20261019"}
    first = (await api.get("/api/trading/v2/executions", params=params)).json()
    assert first["raw_close"] is None
    second = (await api.get("/api/trading/v2/executions", params={**params, "cursor": first["next_cursor"]})).json()
    assert second["raw_close"] == "74000"
    assert sum(api == "ka10081" for api, _, _ in requests) == 1


def test_individual_execution_id_keeps_equal_second_equal_quantity_fills_distinct():
    first = parse_execution(fill(), account_ref="acc_fixture", code="005930", date="20261019")
    second = parse_execution(fill("0000002"), account_ref="acc_fixture", code="005930", date="20261019")
    assert first.execution_id != second.execution_id
    assert first.t_ms == second.t_ms
