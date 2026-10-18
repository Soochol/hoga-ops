from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import ValidationError

from hoga.api.trading_routes import require_order_header
from hoga.trading.contracts import (
    BrokerAccounts,
    BrokerBalances,
    BrokerCommand,
    BrokerCommandResult,
    BrokerCommandStatus,
    BrokerHoldings,
    BrokerOrderState,
    BrokerState,
    CancelBrokerOrders,
    CreateBrokerOrder,
    ModifyBrokerOrder,
    ReviewBrokerCommand,
)
from hoga.trading.models import TradingCancelResponse, TradingReviewResponse
from hoga.trading.multi_broker import BrokerTradingService
from hoga.trading.toss import TradingError

AccountRef = Annotated[str, Query(pattern=r"^acc_[a-f0-9]{32}$")]


async def invoke(operation):
    try:
        return await operation
    except TradingError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code, "message": exc.message}) from exc
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            503, detail={"code": "invalid-broker-response", "message": "증권사 응답을 확인할 수 없습니다."}
        ) from exc


def build_router(service: BrokerTradingService) -> APIRouter:
    router = APIRouter(prefix="/api/trading/v2", tags=["trading"])

    @router.get("/accounts")
    async def accounts() -> BrokerAccounts:
        return await invoke(service.accounts())

    @router.get("/state")
    async def state(
        account_ref: AccountRef,
        code: str = Query(pattern=r"^[A-Za-z0-9]{6}$"),
        part: Literal["all", "orders", "balances"] = "all",
        price: int | None = Query(default=None, gt=0),
    ) -> BrokerState | BrokerOrderState | BrokerBalances:
        if part == "orders":
            return await invoke(service.state(account_ref, code))
        if part == "balances":
            return await invoke(service.balances(account_ref, code, price))
        import asyncio  # noqa: PLC0415

        orders, balances = await asyncio.gather(
            invoke(service.state(account_ref, code)), invoke(service.balances(account_ref, code, price))
        )
        return {**balances.model_dump(), **orders.model_dump()}

    @router.get("/account-orders")
    async def account_orders(account_ref: AccountRef) -> BrokerOrderState:
        return await invoke(service.state(account_ref, ""))

    @router.get("/holdings")
    async def holdings(account_ref: AccountRef) -> BrokerHoldings:
        return await invoke(service.holdings(account_ref))

    @router.post("/orders")
    async def create(body: CreateBrokerOrder, x_hoga_order: str | None = Header(default=None)) -> BrokerCommandResult:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "create"))

    @router.post("/orders/{order_ref}/modify")
    async def modify(
        order_ref: str, body: ModifyBrokerOrder, x_hoga_order: str | None = Header(default=None)
    ) -> BrokerCommandResult:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "modify", order_ref))

    @router.post("/orders/{order_ref}/cancel")
    async def cancel(
        order_ref: str, body: BrokerCommand, x_hoga_order: str | None = Header(default=None)
    ) -> BrokerCommandResult:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "cancel", order_ref))

    @router.post("/cancel-all", response_model_exclude_unset=True)
    async def cancel_all(
        body: CancelBrokerOrders, x_hoga_order: str | None = Header(default=None)
    ) -> TradingCancelResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.cancel_all(body))

    @router.get("/commands/{command_id}")
    async def status(command_id: str, account_ref: AccountRef) -> BrokerCommandStatus:
        return await invoke(service.command_status(account_ref, command_id))

    @router.post("/commands/{command_id}/review")
    async def review(
        command_id: str, body: ReviewBrokerCommand, x_hoga_order: str | None = Header(default=None)
    ) -> TradingReviewResponse:
        require_order_header(x_hoga_order)
        if body.command_id != command_id:
            raise HTTPException(409, detail={"code": "command-id-conflict", "message": "요청 식별자가 다릅니다."})
        await invoke(service.review(body))
        return {"command_id": command_id}

    return router
