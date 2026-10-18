"""Broker-independent facade and durable Kiwoom commands; Toss uses its existing engine."""

from __future__ import annotations

import asyncio
import contextlib
import sqlite3
import time
import uuid
from collections import defaultdict
from pathlib import Path
from typing import Any

from hoga.live import kiwoom_runtime
from hoga.trading.accounts import AccountRegistry
from hoga.trading.brokers import TossTradingAdapter
from hoga.trading.commands import dispatch_command
from hoga.trading.contracts import (
    BrokerAccounts,
    BrokerCommand,
    BrokerCommandResult,
    CancelBrokerOrders,
    CreateBrokerOrder,
    ModifyBrokerOrder,
)
from hoga.trading.kiwoom import KiwoomAccountGateway, KiwoomTradingAdapter
from hoga.trading.models import TradingCommand
from hoga.trading.service import TradingService
from hoga.trading.toss import TradingError


class BrokerTradingService:
    def __init__(
        self, data_dir: Path, toss: TradingService, *, kiwoom: list[KiwoomTradingAdapter] | None = None, on_event=None
    ) -> None:
        self.data_dir, self.legacy = data_dir, toss
        self.registry = AccountRegistry(data_dir / "trading/accounts.sqlite3")
        self.toss = TossTradingAdapter(toss, self.registry)
        self.journal = toss.journal  # Preserve all old commands and unknown outcomes in place.
        self._kiwoom = kiwoom
        self._by_ref: dict[str, Any] = {}
        self._tasks: dict[str, asyncio.Task] = {}
        self._batches: dict[str, asyncio.Task] = {}
        self._locks = defaultdict(asyncio.Lock)
        self._order_locks = defaultdict(asyncio.Lock)
        self._event_releases: dict[str, Any] = {}
        self.on_event = on_event or (lambda event: None)

    def adapters(self) -> list[KiwoomTradingAdapter]:
        if self._kiwoom is None:
            self._kiwoom = []
            for env in ("real", "mock"):
                ids = kiwoom_runtime.configured_account_ids(self.data_dir, environment=env)
                for index in ids:
                    provider = kiwoom_runtime.ensure_token_provider_for_account(index, self.data_dir, environment=env)
                    if provider is not None:
                        self._kiwoom.append(
                            KiwoomTradingAdapter(
                                KiwoomAccountGateway(provider, environment=env, account_index=index),
                                self.registry,
                                self.data_dir,
                            )
                        )
        return self._kiwoom

    async def accounts(self) -> BrokerAccounts:
        result = BrokerAccounts(configured=self.legacy.configured() or bool(self.adapters()))
        try:
            accounts = await self.toss.accounts()
            for account in accounts:
                self._by_ref[account.account_ref] = self.toss
            result.accounts.extend(accounts)
        except TradingError as exc:
            result.errors["toss"] = exc.message
        for adapter in self.adapters():
            try:
                account = await adapter.account()
                # Different credentials may refer to the same account; keep one owner.
                owner = self._by_ref.get(account.account_ref)
                if owner is not None and owner is not adapter:
                    continue
                self._by_ref[account.account_ref] = adapter
                if account.account_ref not in {a.account_ref for a in result.accounts}:
                    result.accounts.append(account)
                adapter.on_change = lambda a=adapter: self.on_event(
                    {"type": "trading_changed_v2", "account_ref": a.account_ref, "revision": a.revision}
                )
            except TradingError as exc:
                result.errors[adapter.credential] = exc.message
        return result

    async def resolve(self, ref: str):
        if ref not in self._by_ref:
            await self.accounts()
        adapter = self._by_ref.get(ref)
        if adapter is None:
            raise TradingError(403, "account-not-found", "연결된 주문 계좌를 선택하세요.")
        if adapter is self.toss:
            await adapter.authorize(ref)
        else:
            account = await adapter.account()
            if account.account_ref != ref:
                raise TradingError(409, "account-binding-changed", "주문 계좌 연결을 확인하세요.")
        return adapter

    async def ensure_events(self, adapter: KiwoomTradingAdapter) -> None:
        if adapter.account_ref in self._event_releases:
            return
        from hoga.live.account_events import subscribe_account  # noqa: PLC0415

        try:
            self._event_releases[adapter.account_ref] = await subscribe_account(
                self.data_dir,
                adapter.gateway.environment,
                adapter.gateway.account_index,
                adapter.account_event,
                lambda connected: self._connection_changed(adapter, connected),
            )
        except (ConnectionError, OSError, TimeoutError):
            adapter.events_connected = False  # REST fallback; retry subscription on the next read.

    @staticmethod
    def _connection_changed(adapter, connected: bool) -> None:
        adapter.events_connected = connected
        adapter.changed()

    def toss_order_event(self, seq: int, order, revision: int) -> None:
        for ref, native_seq in self.toss.accounts_by_ref.items():
            if seq == native_seq:
                event = {"type": "trading_changed_v2", "account_ref": ref, "revision": revision}
                try:
                    normalized = self.toss.order(ref, order).model_dump()
                except (ValueError, TypeError, TradingError, OSError, sqlite3.Error):
                    pass  # A v2 display conversion must never interrupt the legacy Toss event path.
                else:
                    event.update(type="trading_order_v2", order=normalized)
                self.on_event(event)

    async def state(self, ref: str, code: str):
        adapter = await self.resolve(ref)
        if adapter is self.toss:
            return await adapter.state(ref, code)
        await self.ensure_events(adapter)
        state = await adapter.order_state(code)
        state.unresolved_commands = self.unresolved(ref, code)
        return state

    async def balances(self, ref: str, code: str, price: int | None = None):
        adapter = await self.resolve(ref)
        return await adapter.balances(ref, code) if adapter is self.toss else await adapter.balances(code, price)

    async def holdings(self, ref: str):
        adapter = await self.resolve(ref)
        if adapter is self.toss:
            return await adapter.holdings(ref)
        items = await adapter.holdings()
        return {
            "account_ref": ref,
            "fetched_at_ms": int(time.time() * 1000),
            "holdings": [{k: v for k, v in item.items() if k != "sellable_quantity"} for item in items],
        }

    def unresolved(self, ref: str, code: str = "") -> list[str]:
        return [
            cid
            for cid, _, state, _ in self.journal.scoped(ref, code)
            if state in {"prepared", "sending", "unknown"} and cid not in self._tasks and cid not in self._batches
        ]

    async def execute(self, command: BrokerCommand, action: str, order_ref: str = "") -> BrokerCommandResult:
        adapter = await self.resolve(command.account_ref)
        if adapter is self.toss:
            return await adapter.execute(command, action, order_ref)
        payload = {
            **command.model_dump(),
            "schema_version": 2,
            "broker": "kiwoom",
            "environment": adapter.gateway.environment,
            "action": action,
            "order_id": order_ref,
        }
        return await dispatch_command(
            self.journal,
            self._tasks,
            command.command_id,
            payload,
            lambda: self._execute(adapter, command, action, order_ref),
            BrokerCommandResult.model_validate,
            prepared=True,
        )

    async def _execute(self, adapter, command, action, order_ref):  # noqa: PLR0912, PLR0915
        # One serialized preflight/send/journal boundary; no implicit write retries.
        sent = False
        deadline = time.monotonic() + 10
        target = None

        def mark_sending():
            nonlocal sent
            if target is not None:
                adapter.validate_current(target)
            self.journal.finish(command.command_id, "sending", {})
            sent = True

        try:
            # All writes on one symbol serialize, including fresh status checks.
            async with self._locks[(command.account_ref, command.code)]:  # noqa: SIM117
                async with self._order_locks[(command.account_ref, order_ref or command.command_id)]:
                    account = await adapter.account(fresh=True)
                    if account.account_ref != command.account_ref:
                        raise TradingError(409, "account-binding-changed", "주문 계좌가 변경되었습니다.")
                    unresolved = {cid for cid in self.unresolved(command.account_ref, command.code)}
                    if unresolved and (
                        action == "create"
                        or any(
                            cid in unresolved and payload.get("order_id") == order_ref
                            for cid, payload, _, _ in self.journal.scoped(command.account_ref, command.code)
                        )
                    ):
                        raise TradingError(
                            409, "unresolved-order-exists", "이 계좌·종목의 불명확한 요청을 먼저 확인하세요."
                        )
                    route = (
                        command.route
                        if action == "create"
                        else self.registry.resolve_order(order_ref, command.account_ref)[2]
                    )
                    if route not in account.routes:
                        raise TradingError(
                            409,
                            "kiwoom-orders-disabled",
                            account.blocked_reason or "이 계좌에서 지원하지 않는 주문 거래소입니다.",
                        )
                    if action == "create":
                        if not isinstance(command, CreateBrokerOrder):
                            raise TradingError(422, "invalid-command", "신규 주문 조건을 확인하세요.")
                        TradingService._check_amount(command.price, command.quantity, command.confirm_high_value)
                        # Cash policy is checked at the actual limit price; broker remains final authority.
                        capacity = await adapter.balances(command.code, command.price)
                        allowed = capacity.buyable_quantity if command.side == "BUY" else capacity.sellable_quantity
                        if allowed is None or command.quantity > int(allowed):
                            raise TradingError(409, "order-capacity-unavailable", "현금 주문 가능 수량을 확인하세요.")
                        api_id = "kt10000" if command.side == "BUY" else "kt10001"
                        body = {
                            "dmst_stex_tp": route,
                            "stk_cd": command.code,
                            "ord_qty": str(command.quantity),
                            "ord_uv": str(command.price),
                            "trde_tp": "0",
                        }
                        from datetime import datetime  # noqa: PLC0415

                        from hoga.util.timeenc import KST  # noqa: PLC0415

                        date = datetime.now(KST).strftime("%Y%m%d")
                    else:
                        native, date, route = self.registry.resolve_order(order_ref, command.account_ref)
                        from datetime import datetime  # noqa: PLC0415

                        from hoga.util.timeenc import KST  # noqa: PLC0415

                        if date != datetime.now(KST).strftime("%Y%m%d"):
                            raise TradingError(409, "order-date-mismatch", "이전 영업일의 주문은 변경할 수 없습니다.")
                        snapshot = await adapter.order_state(command.code, fresh=True, date=date)
                        order = next((o for o in snapshot.orders if o.order_ref == order_ref), None)
                        if order is None or not order.editable or order.code != command.code:
                            raise TradingError(
                                409, "order-not-editable", "주문 잔량과 정정·취소 상태를 다시 확인하세요."
                            )
                        target = order
                        adapter.validate_current(order)
                        for _, payload, state, prior in self.journal.scoped(command.account_ref, command.code):
                            if (
                                payload.get("order_id") == order_ref
                                and state in {"accepted", "sending", "unknown"}
                                and payload.get("command_id") != command.command_id
                            ):
                                operation_ref = (prior or {}).get("operation_ref")
                                terminal = next(
                                    (o for o in snapshot.recent_orders if o.order_ref == operation_ref), None
                                )
                                if terminal is None or terminal.status not in {
                                    "CANCELED",
                                    "REPLACED",
                                    "CANCEL_REJECTED",
                                    "REPLACE_REJECTED",
                                }:
                                    raise TradingError(
                                        409, "order-processing", "이 주문의 정정·취소 결과를 동기화 중입니다."
                                    )
                        body = {"dmst_stex_tp": route, "stk_cd": command.code, "orig_ord_no": native}
                        if action == "modify" and isinstance(command, ModifyBrokerOrder):
                            if order.order_type != "LIMIT":
                                raise TradingError(422, "unsupported-order-type", "지정가 주문만 정정할 수 있습니다.")
                            qty = int(order.remaining_quantity) if command.quantity is None else command.quantity
                            if qty != int(order.remaining_quantity):
                                raise TradingError(409, "order-quantity-changed", "현재 잔량 전체를 정정하세요.")
                            TradingService._check_amount(command.price, qty, command.confirm_high_value)
                            body.update(mdfy_qty=str(qty), mdfy_uv=str(command.price))
                            api_id = "kt10002"
                        elif action == "cancel":
                            body["cncl_qty"] = str(order.remaining_quantity)
                            api_id = "kt10003"
                        else:
                            raise TradingError(422, "invalid-command", "주문 동작을 확인하세요.")
                    response, _ = await adapter.gateway.call(
                        api_id, body, before_send=mark_sending, deadline=deadline, write_authorized=True
                    )
                    related = {native, target.original_order_id, target.root_order_id} if target is not None else set()
                    if action != "create" and response.get("base_orig_ord_no") not in related - {None, ""}:
                        raise TradingError(
                            503, "order-outcome-unknown", "원주문 응답이 일치하지 않습니다. 주문 내역을 확인하세요."
                        )
                    native_ref = self.registry.order_ref(command.account_ref, response["ord_no"], date, route)
                    self.registry.remember_lineage(
                        native_ref,
                        order_ref or None,
                        (target.root_order_id if target is not None else None)
                        or response.get("base_orig_ord_no", response["ord_no"]),
                        action,
                    )
                    result = BrokerCommandResult(
                        command_id=command.command_id,
                        order_ref=native_ref if action == "create" else order_ref,
                        operation_ref=None if action == "create" else native_ref,
                    )
                    self.journal.finish(command.command_id, "accepted", result.model_dump())
                    return result
        except TradingError as exc:
            if sent and not exc.code.startswith("kiwoom-rejected-") and exc.code != "order-outcome-unknown":
                exc = TradingError(
                    503, "order-outcome-unknown", "접수 후 처리 결과를 확인할 수 없습니다. 주문 내역을 확인하세요."
                )
            self.journal.finish(
                command.command_id,
                "unknown" if exc.code == "order-outcome-unknown" else "rejected",
                {"status": exc.status, "code": exc.code, "message": exc.message},
            )
            raise exc
        except Exception as exc:
            error = TradingError(
                503,
                "order-outcome-unknown" if sent else "order-preflight-failed",
                "주문 처리 기록과 계좌 내역을 확인하세요.",
            )
            # SENDING remains durable if the disk itself is unavailable.
            with contextlib.suppress(OSError, sqlite3.Error):
                self.journal.finish(
                    command.command_id,
                    "unknown" if sent else "rejected",
                    {"status": error.status, "code": error.code, "message": error.message},
                )
            raise error from exc
        finally:
            adapter.changed()
            self._tasks.pop(command.command_id, None)

    async def cancel_all(self, command: CancelBrokerOrders) -> dict:
        adapter = await self.resolve(command.account_ref)
        if adapter is self.toss:
            return await adapter.cancel_all(command)
        payload = {**command.model_dump(), "schema_version": 2, "action": "bulk", "order_id": ""}
        state, result = self.journal.begin(command.command_id, payload, prepared=True)
        if state == "accepted":
            return result
        if command.command_id in self._batches:
            return await asyncio.shield(self._batches[command.command_id])
        if state not in {"new", "batch"}:
            raise TradingError(409, "order-outcome-unknown", "전체 취소의 기존 결과를 확인하세요.")
        task = asyncio.create_task(self._cancel_all(adapter, command, result if state == "batch" else None))
        self._batches[command.command_id] = task
        return await asyncio.shield(task)

    async def _cancel_all(self, adapter, command, saved):
        try:
            if saved is None:
                snapshot = await adapter.order_state(command.code, fresh=True)
                saved = {
                    "targets": [o.order_ref for o in snapshot.orders if command.side is None or o.side == command.side]
                }
                self.journal.finish(command.command_id, "batch", saved)
            results = []
            for ref in saved["targets"]:
                child = BrokerCommand(
                    account_ref=command.account_ref,
                    code=command.code,
                    command_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{command.command_id}:{ref}")),
                )
                try:
                    response = await self.execute(child, "cancel", ref)
                    results.append({"order_id": ref, "accepted": True, "operation_id": response.operation_ref})
                except TradingError as exc:
                    results.append({"order_id": ref, "accepted": False, "code": exc.code, "message": exc.message})
            result = {"results": results}
            self.journal.finish(command.command_id, "accepted", result)
            return result
        finally:
            self._batches.pop(command.command_id, None)

    async def review(self, command: BrokerCommand) -> None:
        adapter = await self.resolve(command.account_ref)
        if adapter is self.toss:
            await self.legacy.review(
                TradingCommand(
                    account_seq=await adapter.authorize(command.account_ref),
                    command_id=command.command_id,
                    code=command.code,
                )
            )
            return
        if command.command_id in self._tasks or command.command_id in self._batches:
            raise TradingError(409, "order-processing", "아직 요청 처리 중입니다.")
        row = self.journal.lookup(command.command_id)
        if not row or row[0].get("account_ref") != command.account_ref or row[0]["code"] != command.code:
            raise TradingError(409, "command-context-mismatch", "계좌·종목이 다른 요청입니다.")
        if row[1] in {"prepared", "sending", "unknown", "reviewed"}:
            self.journal.finish(
                command.command_id,
                "reviewed",
                {
                    **(row[2] or {}),
                    "reviewed_at_ms": int(time.time() * 1000),
                    "review_reason": "operator-confirmed-broker-history",
                },
            )
        adapter.changed()

    async def command_status(self, ref: str, command_id: str) -> dict:
        adapter = await self.resolve(ref)
        row = self.journal.lookup(command_id)
        owns = row and (
            row[0].get("account_ref") == ref
            or (adapter is self.toss and row[0].get("account_seq") == await adapter.authorize(ref))
        )
        if not owns:
            raise TradingError(404, "command-not-found", "이 계좌의 요청 기록이 없습니다.")
        return {"command_id": command_id, "state": row[1], "result": row[2]}

    async def close(self) -> None:
        await asyncio.gather(*self._tasks.values(), *self._batches.values(), return_exceptions=True)
        await asyncio.gather(*(release() for release in self._event_releases.values()), return_exceptions=True)
        for adapter in self._kiwoom or []:
            await adapter.gateway.close()
