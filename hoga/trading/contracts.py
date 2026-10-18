"""Broker-independent wire contract. Legacy Toss routes retain their old schema."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Broker = Literal["toss", "kiwoom"]
Environment = Literal["real", "mock"]
Route = Literal["KRX", "NXT", "SOR"]


class BrokerAccount(BaseModel):
    account_ref: str
    broker: Broker
    environment: Environment
    label: str
    routes: list[Route] = Field(default_factory=list)
    supported_routes: list[Route] = Field(default_factory=list)
    order_enabled: bool = False
    blocked_reason: str | None = None


class BrokerAccounts(BaseModel):
    configured: bool
    accounts: list[BrokerAccount] = Field(default_factory=list)
    errors: dict[str, str] = Field(default_factory=dict)


class BrokerOrder(BaseModel):
    order_ref: str
    account_ref: str
    broker_order_id: str
    trading_date: str
    original_order_id: str | None = None
    root_order_id: str | None = None
    code: str
    side: Literal["BUY", "SELL"]
    route: Route
    order_type: str = "LIMIT"
    quantity: str
    filled_quantity: str | None = None
    remaining_quantity: str
    price: str | None = None
    status: str
    broker_status: str
    ordered_at: str | None = None
    average_filled_price: str | None = None
    source: Literal["rest", "event"] = "rest"
    editable: bool = False
    operation: Literal["modify", "cancel"] | None = None


class BrokerOrderState(BaseModel):
    account_ref: str
    code: str
    orders: list[BrokerOrder]
    recent_orders: list[BrokerOrder]
    unresolved_commands: list[str] = Field(default_factory=list)
    fetched_at_ms: int
    events_connected: bool = False
    revision: int = 0


class BrokerBalances(BaseModel):
    account_ref: str
    code: str
    buying_power: str | None = None
    buyable_quantity: str | None = None
    sellable_quantity: str | None = None
    holding_quantity: str | None = None
    average_purchase_price: str | None = None
    fetched_at_ms: int
    capacity_status: Literal["available", "unavailable"] = "unavailable"


class BrokerCommand(BaseModel):
    model_config = ConfigDict(extra="forbid")
    account_ref: str = Field(min_length=1, max_length=80, pattern=r"^acc_[a-f0-9]{32}$")
    command_id: str = Field(min_length=1, max_length=36, pattern=r"^[A-Za-z0-9_-]+$")
    code: str = Field(pattern=r"^[A-Za-z0-9]{6}$")


class CreateBrokerOrder(BrokerCommand):
    side: Literal["BUY", "SELL"]
    quantity: int = Field(gt=0, le=1_000_000_000)
    price: int = Field(gt=0, le=1_000_000_000)
    route: Route
    confirm_high_value: bool = False


class ModifyBrokerOrder(BrokerCommand):
    price: int = Field(gt=0, le=1_000_000_000)
    quantity: int | None = Field(default=None, gt=0, le=1_000_000_000)
    confirm_high_value: bool = False


class CancelBrokerOrders(BrokerCommand):
    side: Literal["BUY", "SELL"] | None = None


class BrokerCommandResult(BaseModel):
    command_id: str
    order_ref: str
    operation_ref: str | None = None
    status: str = "accepted"


class ReviewBrokerCommand(BrokerCommand):
    confirmed: Literal[True]
