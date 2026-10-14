from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

TradingSide = Literal["BUY", "SELL"]


class TossExecution(BaseModel):
    filledQuantity: str
    averageFilledPrice: str | None = None
    filledAmount: str | None = None
    commission: str | None = None
    tax: str | None = None
    filledAt: str | None = None
    settlementDate: str | None = None


class TossOrder(BaseModel):
    orderId: str
    symbol: str
    side: TradingSide
    orderType: str
    timeInForce: str
    status: str  # The vendor explicitly requires accepting future status codes.
    price: str | None = None
    quantity: str
    orderAmount: str | None = None
    currency: str
    orderedAt: str
    canceledAt: str | None = None
    execution: TossExecution


class TradingAccount(BaseModel):
    account_seq: int
    label: str


class TradingAccountsResponse(BaseModel):
    configured: bool
    accounts: list[TradingAccount] = Field(default_factory=list)


class TradingOrderStateResponse(BaseModel):
    account_seq: int
    code: str
    orders: list[TossOrder]
    recent_orders: list[TossOrder]
    fetched_at_ms: int
    events_connected: bool
    unresolved_commands: list[str] = Field(default_factory=list)
    revision: int = 0


class TradingBalancesResponse(BaseModel):
    account_seq: int
    code: str
    buying_power: str
    sellable_quantity: str
    holding_quantity: str
    average_purchase_price: str | None = None
    fetched_at_ms: int


class TradingStateResponse(TradingOrderStateResponse, TradingBalancesResponse):
    pass


class TradingCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_seq: int = Field(gt=0)
    command_id: str = Field(min_length=1, max_length=36, pattern=r"^[A-Za-z0-9_-]+$")
    code: str = Field(pattern=r"^[A-Za-z0-9]{6}$")


class CreateTradingOrder(TradingCommand):
    side: TradingSide
    quantity: int = Field(gt=0, le=1_000_000_000)
    price: int = Field(gt=0, le=1_000_000_000)
    confirm_high_value: bool = False


class ModifyTradingOrder(TradingCommand):
    price: int = Field(gt=0, le=1_000_000_000)
    # None means move the CURRENT remainder, fetched just before submission.
    quantity: int | None = Field(default=None, gt=0, le=1_000_000_000)
    confirm_high_value: bool = False


class CancelTradingOrders(TradingCommand):
    side: TradingSide | None = None


class TradingCommandResponse(BaseModel):
    command_id: str
    order_id: str
    status: str = "accepted"  # HTTP acceptance is not execution/cancel confirmation.


class TradingCancelResult(BaseModel):
    order_id: str
    accepted: bool
    operation_id: str | None = None
    code: str | None = None
    message: str | None = None


class TradingCancelResponse(BaseModel):
    results: list[TradingCancelResult]


class ReviewTradingCommand(TradingCommand):
    confirmed: Literal[True]


class TradingReviewResponse(BaseModel):
    command_id: str


class ResetPaperAccount(TradingCommand):
    cash: int = Field(ge=0, le=1_000_000_000_000)
    holding_quantity: int = Field(ge=0, le=1_000_000_000)
    average_purchase_price: int = Field(gt=0, le=1_000_000_000)
    confirmed: Literal[True]
