from __future__ import annotations

from collections.abc import Awaitable
from typing import TypeVar

from fastapi import APIRouter, Header, HTTPException, Query
from pydantic import ValidationError

from hoga.trading.models import (
    CancelTradingOrders,
    CreateTradingOrder,
    ModifyTradingOrder,
    ResetPaperAccount,
    ReviewTradingCommand,
    TradingAccountsResponse,
    TradingCancelResponse,
    TradingCommand,
    TradingCommandResponse,
    TradingReviewResponse,
    TradingStateResponse,
)
from hoga.trading.paper import PaperTradingService
from hoga.trading.service import TradingService
from hoga.trading.toss import TradingError

T = TypeVar("T")


async def invoke(operation: Awaitable[T]) -> T:
    try:
        return await operation
    except TradingError as exc:
        raise HTTPException(exc.status, detail={"code": exc.code, "message": exc.message}) from exc
    except (ValidationError, KeyError, TypeError, ValueError) as exc:
        raise HTTPException(
            503, detail={"code": "invalid-toss-response", "message": "토스증권 응답을 확인할 수 없습니다."}
        ) from exc


def require_order_header(value: str | None) -> None:
    # A non-simple header requires the existing allowlisted CORS preflight.
    if value != "1":
        raise HTTPException(403, detail={"code": "order-header-required", "message": "주문창에서 요청해주세요."})


def build_router(service: TradingService | PaperTradingService, prefix: str = "/api/trading") -> APIRouter:
    router = APIRouter(prefix=prefix, tags=["trading"])

    @router.get("/accounts")
    async def accounts() -> TradingAccountsResponse:
        return await invoke(service.accounts())

    @router.get("/state")
    async def state(
        account_seq: int = Query(gt=0), code: str = Query(pattern=r"^[A-Za-z0-9]{6}$")
    ) -> TradingStateResponse:
        return await invoke(service.state(account_seq, code))

    @router.post("/orders")
    async def create(
        body: CreateTradingOrder, x_hoga_order: str | None = Header(default=None)
    ) -> TradingCommandResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "create"))

    @router.post("/orders/{order_id}/modify")
    async def modify(
        order_id: str, body: ModifyTradingOrder, x_hoga_order: str | None = Header(default=None)
    ) -> TradingCommandResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "modify", order_id))

    @router.post("/orders/{order_id}/cancel")
    async def cancel(
        order_id: str, body: TradingCommand, x_hoga_order: str | None = Header(default=None)
    ) -> TradingCommandResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.execute(body, "cancel", order_id))

    @router.post("/cancel-all")
    async def cancel_all(
        body: CancelTradingOrders, x_hoga_order: str | None = Header(default=None)
    ) -> TradingCancelResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.cancel_all(body))

    @router.post("/commands/{command_id}/review")
    async def review(
        command_id: str, body: ReviewTradingCommand, x_hoga_order: str | None = Header(default=None)
    ) -> TradingReviewResponse:
        require_order_header(x_hoga_order)
        if command_id != body.command_id:
            raise HTTPException(409, detail={"code": "command-id-conflict", "message": "요청 식별자가 다릅니다."})
        await invoke(service.review(body))
        return TradingReviewResponse(command_id=command_id)

    return router


def build_paper_router(service: PaperTradingService) -> APIRouter:
    router = build_router(service, prefix="/api/paper-trading")

    @router.post("/reset")
    async def reset(
        body: ResetPaperAccount, x_hoga_order: str | None = Header(default=None)
    ) -> TradingStateResponse:
        require_order_header(x_hoga_order)
        return await invoke(service.reset(body))

    return router
