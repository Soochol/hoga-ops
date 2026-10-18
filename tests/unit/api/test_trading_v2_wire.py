"""HTTP serialization must preserve both state halves and operation-specific receipts."""
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_v2_routes import build_router
from hoga.trading.contracts import BrokerBalances, BrokerOrderState

REF = "acc_" + "a" * 32
ORDERS = BrokerOrderState(account_ref=REF, code="005930", orders=[], recent_orders=[], fetched_at_ms=123)
BALANCES = BrokerBalances(account_ref=REF, code="005930", fetched_at_ms=122, buying_power="500",
                          buyable_quantity="3", capacity_status="available")


async def client_for(**methods):
    app = FastAPI()
    app.include_router(build_router(SimpleNamespace(**methods)))
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")


@pytest.mark.parametrize("part", ["all", "orders", "balances"])
async def test_state_wire_preserves_every_field_without_cross_part_defaults(part):
    async def state(*args):
        return ORDERS

    async def balances(*args):
        return BALANCES

    async with await client_for(state=state, balances=balances) as api:
        response = await api.get("/api/trading/v2/state", params={"account_ref": REF, "code": "005930", "part": part})
    expected = (ORDERS.model_dump() if part == "orders" else BALANCES.model_dump() if part == "balances"
                else {**BALANCES.model_dump(), **ORDERS.model_dump()})
    assert response.status_code == 200
    assert response.json() == expected


async def test_receipt_and_partial_cancel_keys_survive_response_validation():
    receipt = {"command_id": "example", "state": "reviewed",
               "result": {"reviewed_at_ms": 123, "review_reason": "manual", "targets": ["opaque"]}}
    cancel = {"results": [{"order_id": "opaque", "accepted": True, "operation_id": "operation"},
                          {"order_id": "other", "accepted": False, "code": "denied", "message": "blocked"}]}
    holdings = {"account_ref": REF, "fetched_at_ms": 123, "holdings": [
        {"code": "005930", "name": "삼성전자", "quantity": "2", "average_purchase_price": "67200"}]}

    async def status(*args):
        return receipt

    async def cancel_all(*args):
        return cancel

    async def holding_list(*args):
        return holdings

    async with await client_for(command_status=status, cancel_all=cancel_all, holdings=holding_list) as api:
        assert (await api.get("/api/trading/v2/commands/example", params={"account_ref": REF})).json() == receipt
        assert (await api.get("/api/trading/v2/holdings", params={"account_ref": REF})).json() == holdings
        response = await api.post("/api/trading/v2/cancel-all", headers={"X-Hoga-Order": "1"},
                                  json={"account_ref": REF, "command_id": "example", "code": "005930"})
        assert response.status_code == 200 and response.json() == cancel
