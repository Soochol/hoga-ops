"""Toss adapter delegates commands to the existing engine, including its locks/journal."""

from __future__ import annotations

from datetime import datetime

from hoga.trading.accounts import AccountRegistry
from hoga.trading.contracts import (
    BrokerAccount,
    BrokerBalances,
    BrokerCommand,
    BrokerCommandResult,
    BrokerOrder,
    BrokerOrderState,
    CancelBrokerOrders,
    CreateBrokerOrder,
    ModifyBrokerOrder,
)
from hoga.trading.models import CancelTradingOrders, CreateTradingOrder, ModifyTradingOrder, TossOrder, TradingCommand
from hoga.trading.service import EDITABLE_STATES, TradingService, remaining
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST


class TossTradingAdapter:
    def __init__(self, service: TradingService, registry: AccountRegistry) -> None:
        self.service, self.registry = service, registry
        self.accounts_by_ref: dict[str, int] = {}

    async def accounts(self) -> list[BrokerAccount]:
        await self.service.accounts()
        result = []
        for account in self.service._accounts:
            seq = account["accountSeq"]
            ref = self.registry.bind(f"toss:real:{seq}", "toss", "real", str(account["accountNo"]))
            self.accounts_by_ref[ref] = seq
            result.append(
                BrokerAccount(
                    account_ref=ref,
                    broker="toss",
                    environment="real",
                    label=f"토스증권 · 실전 · ****{str(account['accountNo'])[-4:]}",
                    routes=["SOR"],
                    supported_routes=["SOR"],
                    order_enabled=True,
                )
            )
        return result

    async def authorize(self, account_ref: str) -> int:
        if account_ref not in self.accounts_by_ref:
            await self.accounts()
        seq = self.accounts_by_ref.get(account_ref)
        if seq is None:
            raise TradingError(403, "account-not-found", "연결된 주문 계좌를 선택하세요.")
        await self.service.authorize(seq)
        account = next((a for a in self.service._accounts if a["accountSeq"] == seq), None)
        if (
            account is None
            or self.registry.bind(f"toss:real:{seq}", "toss", "real", str(account["accountNo"])) != account_ref
        ):
            raise TradingError(409, "account-binding-changed", "선택한 주문 계좌 연결을 확인하세요.")
        return seq

    def order(self, account_ref: str, order: TossOrder) -> BrokerOrder:
        date = datetime.fromisoformat(order.orderedAt).astimezone(KST).strftime("%Y%m%d")
        return BrokerOrder(
            order_ref=self.reference(account_ref, order.orderId, date),
            account_ref=account_ref,
            broker_order_id=order.orderId,
            trading_date=date,
            code=order.symbol,
            side=order.side,
            route="SOR",
            order_type=order.orderType,
            quantity=order.quantity,
            filled_quantity=order.execution.filledQuantity,
            remaining_quantity=str(remaining(order)),
            price=order.price,
            status=order.status,
            broker_status=order.status,
            ordered_at=order.orderedAt,
            average_filled_price=order.execution.averageFilledPrice,
            editable=order.status in EDITABLE_STATES,
        )

    def reference(self, account_ref: str, native: str, date: str) -> str:
        # Toss order IDs are global. Reuse an ACK reference when canonical time arrives later.
        with self.registry.connect() as db:
            row = db.execute(
                "SELECT ref FROM orders WHERE account_ref=? AND native_id=?", (account_ref, native)
            ).fetchone()
        return row[0] if row else self.registry.order_ref(account_ref, native, date, "SOR")

    async def state(self, ref: str, code: str) -> BrokerOrderState:
        seq = await self.authorize(ref)
        state = await self.service.order_state(seq, code)
        return BrokerOrderState(
            account_ref=ref,
            code=code,
            orders=[self.order(ref, o) for o in state.orders],
            recent_orders=[self.order(ref, o) for o in state.recent_orders],
            unresolved_commands=state.unresolved_commands,
            fetched_at_ms=state.fetched_at_ms,
            events_connected=state.events_connected,
            revision=state.revision,
        )

    async def balances(self, ref: str, code: str) -> BrokerBalances:
        state = await self.service.balances(await self.authorize(ref), code)
        return BrokerBalances(
            account_ref=ref,
            code=code,
            buying_power=state.buying_power,
            sellable_quantity=state.sellable_quantity,
            holding_quantity=state.holding_quantity,
            average_purchase_price=state.average_purchase_price,
            fetched_at_ms=state.fetched_at_ms,
            capacity_status="available",
        )

    async def holdings(self, ref: str) -> dict:
        state = await self.service.account_holdings(await self.authorize(ref))
        return {
            "account_ref": ref,
            "fetched_at_ms": state.fetched_at_ms,
            "holdings": [h.model_dump() for h in state.holdings],
        }

    async def execute(self, command: BrokerCommand, action: str, order_ref: str = "") -> BrokerCommandResult:
        seq = await self.authorize(command.account_ref)
        common = {"account_seq": seq, "code": command.code, "command_id": command.command_id}
        date = datetime.now(KST).strftime("%Y%m%d")
        native = ""
        if action != "create":
            native, date, _ = self.registry.resolve_order(order_ref, command.account_ref)
        if isinstance(command, CreateBrokerOrder):
            if command.order_type != "LIMIT":
                raise TradingError(
                    422, "unsupported-order-type", "토스 OpenAPI는 장전 시간외 종가 주문을 지원하지 않습니다."
                )
            if command.route != "SOR":
                raise TradingError(422, "unsupported-route", "토스증권 주문은 통합(SOR) 경로를 사용합니다.")
            legacy = CreateTradingOrder(
                **common,
                side=command.side,
                price=command.price,
                quantity=command.quantity,
                confirm_high_value=command.confirm_high_value,
            )
        elif isinstance(command, ModifyBrokerOrder):
            legacy = ModifyTradingOrder(
                **common, price=command.price, quantity=command.quantity, confirm_high_value=command.confirm_high_value
            )
        else:
            legacy = TradingCommand(**common)
        response = await self.service.execute(legacy, action, native)
        result_ref = self.reference(command.account_ref, response.order_id, date)
        return BrokerCommandResult(
            command_id=command.command_id,
            order_ref=result_ref if action == "create" else order_ref,
            operation_ref=None if action == "create" else result_ref,
        )

    async def cancel_all(self, command: CancelBrokerOrders) -> dict:
        seq = await self.authorize(command.account_ref)
        result = await self.service.cancel_all(
            CancelTradingOrders(account_seq=seq, code=command.code, command_id=command.command_id, side=command.side)
        )
        date = datetime.now(KST).strftime("%Y%m%d")
        return {
            "results": [
                {
                    **r.model_dump(),
                    "order_id": self.reference(command.account_ref, r.order_id, date),
                    "operation_id": self.reference(command.account_ref, r.operation_id, date)
                    if r.operation_id
                    else None,
                }
                for r in result.results
            ]
        }
