from __future__ import annotations

import asyncio
import contextlib
import json
import os
import sqlite3
import time
import uuid
from collections import defaultdict
from collections.abc import Callable
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from urllib.parse import quote

from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus, WebSocketException

from hoga.trading.models import (
    CancelTradingOrders,
    CreateTradingOrder,
    ModifyTradingOrder,
    TossOrder,
    TradingAccount,
    TradingAccountsResponse,
    TradingBalancesResponse,
    TradingCancelResponse,
    TradingCancelResult,
    TradingCommand,
    TradingCommandResponse,
    TradingHolding,
    TradingHoldingsResponse,
    TradingOrderStateResponse,
    TradingStateResponse,
)
from hoga.trading.toss import HTTP_UNAUTHORIZED, TossClient, TradingError

OPEN_STATES = frozenset({"PENDING", "PARTIAL_FILLED", "PENDING_CANCEL", "PENDING_REPLACE"})
EDITABLE_STATES = frozenset({"PENDING", "PARTIAL_FILLED"})
TERMINAL_STATES = frozenset({"FILLED", "CANCELED", "REPLACED", "REJECTED", "CANCEL_REJECTED", "REPLACE_REJECTED"})
HIGH_VALUE_WON = 100_000_000
ACCOUNT_CACHE_SECONDS = 60
STATE_CACHE_SECONDS = 3
HOLDINGS_CACHE_SECONDS = 10
DOMESTIC_CODE_LENGTH = 6
MAX_CONCURRENT_CANCELS = 10


def remaining(order: TossOrder) -> int:
    try:
        qty = Decimal(order.quantity) - Decimal(order.execution.filledQuantity)
        if not qty.is_finite() or qty != qty.to_integral_value():
            raise ValueError("invalid domestic quantity")
        return max(0, int(qty))
    except (InvalidOperation, ValueError) as exc:
        raise TradingError(503, "invalid-toss-response", "주문 잔여 수량을 확인할 수 없습니다.") from exc


class CommandJournal:
    """A request is persisted BEFORE submitting it; restart never replays writes."""

    def __init__(self, path: Path) -> None:
        self.path = path

    def _connect(self) -> sqlite3.Connection:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        db = sqlite3.connect(self.path)
        db.execute(
            "CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY, payload TEXT NOT NULL, "
            "state TEXT NOT NULL, result TEXT, created REAL NOT NULL)"
        )
        return db

    def begin(self, command_id: str, payload: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
        encoded = json.dumps(payload, sort_keys=True)
        with contextlib.closing(self._connect()) as db, db:
            row = db.execute("SELECT payload, state, result FROM commands WHERE id=?", (command_id,)).fetchone()
            if row:
                if row[0] != encoded:
                    raise TradingError(409, "command-id-conflict", "같은 요청 식별자로 주문 내용을 바꿀 수 없습니다.")
                return row[1], json.loads(row[2]) if row[2] else None
            db.execute("INSERT INTO commands VALUES (?, ?, 'sending', NULL, ?)", (command_id, encoded, time.time()))
        return "new", None

    def finish(self, command_id: str, state: str, result: dict[str, Any]) -> None:
        with contextlib.closing(self._connect()) as db, db:
            db.execute("UPDATE commands SET state=?, result=? WHERE id=?", (state, json.dumps(result), command_id))

    def unresolved(self, account: int, code: str) -> list[str]:
        if not self.path.exists():
            return []
        with contextlib.closing(self._connect()) as db, db:
            rows = db.execute("SELECT id, payload FROM commands WHERE state IN ('sending', 'unknown')").fetchall()
        return [cid for cid, raw in rows if (p := json.loads(raw))["account_seq"] == account and p["code"] == code]

    def review(self, command_id: str, account: int, code: str) -> None:
        with contextlib.closing(self._connect()) as db, db:
            row = db.execute("SELECT payload, state FROM commands WHERE id=?", (command_id,)).fetchone()
            if not row:
                raise TradingError(404, "command-not-found", "요청 기록이 없습니다.")
            payload = json.loads(row[0])
            if payload["account_seq"] != account or payload["code"] != code:
                raise TradingError(403, "command-context-mismatch", "계좌·종목이 다른 요청입니다.")
            if row[1] in ("sending", "unknown", "reviewed"):
                db.execute("UPDATE commands SET state='reviewed' WHERE id=?", (command_id,))

    def latest_operation(self, account: int, code: str, order_id: str) -> str | None:
        if not self.path.exists():
            return None
        with contextlib.closing(self._connect()) as db, db:
            rows = db.execute(
                "SELECT payload, result FROM commands WHERE state='accepted' ORDER BY created DESC"
            ).fetchall()
        for raw, result in rows:
            payload = json.loads(raw)
            if payload["account_seq"] == account and payload["code"] == code and payload["order_id"] == order_id:
                return json.loads(result)["order_id"]
        return None

    def uncertain_operation(self, command: TradingCommand, order_id: str, active: set[str]) -> bool:
        with contextlib.closing(self._connect()) as db, db:
            rows = db.execute("SELECT id, payload FROM commands WHERE state IN ('sending', 'unknown')").fetchall()
        for cid, raw in rows:
            p = json.loads(raw)
            if (
                cid != command.command_id
                and cid not in active
                and p["account_seq"] == command.account_seq
                and p["code"] == command.code
                and p["order_id"] == order_id
            ):
                return True
        return False


class TradingService:
    def __init__(
        self, data_dir: Path, client: TossClient | None = None, on_change: Callable[[int], None] | None = None,
        on_order_change: Callable[[int, TossOrder, int], None] | None = None,
    ) -> None:
        self.client = client
        self.journal = CommandJournal(data_dir / "trading" / "commands.sqlite3")
        self._accounts: list[dict[str, Any]] = []
        self._accounts_at = 0.0
        self._accounts_lock = asyncio.Lock()
        self._locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._order_locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._cancel_slots = asyncio.Semaphore(MAX_CONCURRENT_CANCELS)
        self._state_locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._balance_locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._snapshots: dict[tuple[int, str], tuple[float, TradingOrderStateResponse]] = {}
        self._balances: dict[tuple[int, str], tuple[float, TradingBalancesResponse]] = {}
        self._holdings: dict[int, tuple[float, list[dict[str, Any]]]] = {}
        self._holding_locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._stocks: dict[str, tuple[float, dict[str, Any]]] = {}
        self._commands: dict[str, asyncio.Task[TradingCommandResponse]] = {}
        self._batches: dict[str, asyncio.Task[TradingCancelResponse]] = {}
        self._events_task: asyncio.Task[None] | None = None
        self.events_connected = False
        self.revision = 0
        self.on_change = on_change
        self.on_order_change = on_order_change
        self._event_orders: dict[tuple[int, str], TossOrder] = {}

    def configured(self) -> bool:
        return self.client is not None or bool(
            os.getenv("TOSSINVEST_CLIENT_ID") and os.getenv("TOSSINVEST_CLIENT_SECRET")
        )

    def _client(self) -> TossClient:
        if self.client is None:
            if not self.configured():
                raise TradingError(
                    503, "toss-unconfigured", "토스증권 Open API의 CLIENT_ID와 CLIENT_SECRET을 서버에 설정하세요."
                )
            self.client = TossClient(os.environ["TOSSINVEST_CLIENT_ID"], os.environ["TOSSINVEST_CLIENT_SECRET"])
        return self.client

    async def accounts(self) -> TradingAccountsResponse:
        if not self.configured():
            return TradingAccountsResponse(configured=False)
        async with self._accounts_lock:
            if time.monotonic() - self._accounts_at >= ACCOUNT_CACHE_SECONDS:
                raw = await self._client().request("GET", "/api/v1/accounts")
                self._accounts = [a for a in raw if a.get("accountType") == "BROKERAGE"]
                self._accounts_at = time.monotonic()
        return TradingAccountsResponse(
            configured=True,
            accounts=[
                TradingAccount(account_seq=a["accountSeq"], label=f"토스증권 · ****{str(a['accountNo'])[-4:]}")
                for a in self._accounts
            ],
        )

    async def authorize(self, account: int) -> None:
        accounts = await self.accounts()
        if not any(a.account_seq == account for a in accounts.accounts):
            raise TradingError(403, "account-not-found", "본인 토스증권 계좌를 선택하세요.")

    def changed(self, *, notify: bool = True) -> None:
        self._snapshots.clear()
        self._balances.clear()
        self._holdings.clear()
        self.revision += 1
        if notify and self.on_change:
            self.on_change(self.revision)

    def order_event(self, frame: dict[str, Any]) -> None:
        """Publish validated display snapshots; command validation still uses fresh REST."""
        try:
            data = frame["data"]
            account = int(data["accountSeq"])
            if frame.get("topic") != f"personal:order:{account}" or not any(
                a["accountSeq"] == account for a in self._accounts
            ):
                return
            order = TossOrder.model_validate(data["order"])
            quantity = Decimal(order.quantity)
            filled = Decimal(order.execution.filledQuantity)
            if order.currency != "KRW" or len(order.symbol) != DOMESTIC_CODE_LENGTH or not order.symbol.isalnum():
                self.changed()
                return
            invalid = any(not n.is_finite() or n < 0 or n != n.to_integral_value() for n in (quantity, filled))
            if invalid or filled > quantity:
                raise ValueError("invalid domestic execution quantity")
        except (KeyError, TypeError, ValueError, InvalidOperation):
            self.changed()  # Unknown/malformed frames trigger canonical reconciliation.
            return
        self.changed(notify=self.on_order_change is None)
        key = (account, order.orderId)
        previous = self._event_orders.get(key)
        if previous is None or (filled >= Decimal(previous.execution.filledQuantity)
                               and not (previous.status in TERMINAL_STATES and order.status not in TERMINAL_STATES)):
            self._event_orders[key] = order
        if self.on_order_change:
            self.on_order_change(account, order, self.revision)

    def start_events(self) -> None:
        if self._events_task is None or self._events_task.done():
            self._events_task = asyncio.create_task(self._events_loop())

    async def _events_loop(self) -> None:
        delay = 1
        while True:
            try:
                token = await self._client().token()
                async with connect(
                    TossClient.WS_URL,
                    additional_headers={"Authorization": f"Bearer {token}"},
                    ping_interval=60,
                    ping_timeout=20,
                    open_timeout=12,
                    max_queue=32,
                ) as ws:
                    await ws.send(
                        json.dumps(
                            [{"type": "personal:order", "codes": [str(a["accountSeq"]) for a in self._accounts]}]
                        )
                    )
                    async for raw in ws:
                        frame = json.loads(raw)
                        if frame.get("type") == "subscriptions":
                            self.events_connected = bool(frame.get("subscribed")) and not frame.get("rejected")
                            if not self.events_connected:
                                raise TradingError(503, "order-events-unavailable", "주문 이벤트 구독을 확인하세요.")
                            delay = 1
                            self.changed()  # Always reconcile after (re)connection.
                        elif frame.get("type") == "message" and str(frame.get("topic", "")).startswith(
                            "personal:order:"
                        ):
                            self.order_event(frame)
                        elif frame.get("type") == "error":
                            raise TradingError(503, "order-events-unavailable", "주문 이벤트 연결을 확인하세요.")
            except InvalidStatus as exc:
                if exc.response.status_code == HTTP_UNAUTHORIZED:
                    self._client().invalidate_token()
            except (TradingError, WebSocketException, OSError, ValueError, KeyError, TypeError):
                pass  # REST fallback stays available; no secrets in exception logs.
            finally:
                self.events_connected = False
                self.changed()
            await asyncio.sleep(delay)
            delay = min(30, delay * 2)

    async def state(self, account: int, code: str) -> TradingStateResponse:
        orders, balances = await asyncio.gather(self.order_state(account, code), self.balances(account, code))
        return TradingStateResponse(**{**balances.model_dump(), **orders.model_dump()})

    async def order_state(self, account: int, code: str) -> TradingOrderStateResponse:
        await self.authorize(account)
        self.start_events()
        key = (account, code)
        async with self._state_locks[key]:
            cached = self._snapshots.get(key)
            if cached and time.monotonic() - cached[0] < STATE_CACHE_SECONDS:
                return cached[1]
            client = self._client()
            revision = self.revision
            symbol_filter = {"symbol": code} if code else {}
            open_data, closed_data = await asyncio.gather(
                client.request("GET", "/api/v1/orders", account=account,
                               params={"status": "OPEN", **symbol_filter}),
                client.request(
                    "GET", "/api/v1/orders", account=account,
                    params={"status": "CLOSED", "limit": 10 if code else 100, **symbol_filter}
                ),
            )
            if not code:
                # OPEN is an all-orders response under the official API contract.
                if open_data.get("hasNext"):
                    raise TradingError(503, "invalid-toss-response", "전체 미체결 주문을 확인할 수 없습니다.")
                for data in (open_data, closed_data):
                    data["orders"] = [o for o in data["orders"] if o.get("currency") == "KRW"
                                      and len(o.get("symbol", "")) == DOMESTIC_CODE_LENGTH
                                      and o["symbol"].isascii() and o["symbol"].isalnum()]
            result = TradingOrderStateResponse(
                account_seq=account,
                code=code,
                orders=[TossOrder.model_validate(o) for o in open_data["orders"]],
                recent_orders=[TossOrder.model_validate(o) for o in closed_data["orders"]],
                fetched_at_ms=int(time.time() * 1000),
                events_connected=self.events_connected,
                unresolved_commands=self.uncertain(account, code),
                revision=revision,
            )
            if revision == self.revision:
                self._snapshots[key] = time.monotonic(), result
            return result

    async def account_orders(self, account: int) -> TradingOrderStateResponse:
        """Empty code is an account snapshot; the public symbol route still requires a code."""
        return await self.order_state(account, "")

    async def account_holdings(self, account: int) -> TradingHoldingsResponse:
        await self.authorize(account)
        result = []
        for item in await self.holdings(account):
            code = item["symbol"]
            if (item.get("marketCountry") != "KR" or item.get("currency") != "KRW"
                    or len(code) != DOMESTIC_CODE_LENGTH or not code.isascii() or not code.isalnum()):
                continue
            try:
                quantity = Decimal(item["quantity"])
                average = Decimal(item["averagePurchasePrice"])
                if (not quantity.is_finite() or quantity < 0 or quantity != quantity.to_integral_value()
                        or not average.is_finite() or average < 0):
                    raise ValueError("invalid domestic holding")
            except (InvalidOperation, ValueError):
                raise TradingError(503, "invalid-toss-response", "보유종목 수량을 확인할 수 없습니다.") from None
            if quantity > 0:
                result.append(TradingHolding(code=code, name=item.get("name") or code, quantity=item["quantity"],
                                             average_purchase_price=item["averagePurchasePrice"]))
        return TradingHoldingsResponse(account_seq=account, holdings=result, fetched_at_ms=int(time.time() * 1000))

    async def balances(self, account: int, code: str) -> TradingBalancesResponse:
        await self.authorize(account)
        key = (account, code)
        async with self._balance_locks[key]:
            cached = self._balances.get(key)
            if cached and time.monotonic() - cached[0] < STATE_CACHE_SECONDS:
                return cached[1]
            revision = self.revision
            client = self._client()
            power, sellable, holdings = await asyncio.gather(
                client.request("GET", "/api/v1/buying-power", account=account, params={"currency": "KRW"}),
                client.request("GET", "/api/v1/sellable-quantity", account=account, params={"symbol": code}),
                self.holdings(account),
            )
            holding = next((h for h in holdings if h["symbol"] == code), None)
            result = TradingBalancesResponse(
                account_seq=account, code=code,
                buying_power=power["cashBuyingPower"], sellable_quantity=sellable["sellableQuantity"],
                holding_quantity=holding["quantity"] if holding else "0",
                average_purchase_price=holding["averagePurchasePrice"] if holding else None,
                fetched_at_ms=int(time.time() * 1000),
            )
            if revision == self.revision:
                self._balances[key] = time.monotonic(), result
            return result

    async def holdings(self, account: int) -> list[dict[str, Any]]:
        async with self._holding_locks[account]:
            cached = self._holdings.get(account)
            if cached and time.monotonic() - cached[0] < HOLDINGS_CACHE_SECONDS:
                return cached[1]
            revision = self.revision
            result = await self._client().request("GET", "/api/v1/holdings", account=account)
            items = result["items"]
            if revision == self.revision:
                self._holdings[account] = time.monotonic(), items
            return items

    async def domestic(self, code: str) -> None:
        cached = self._stocks.get(code)
        if cached and time.monotonic() - cached[0] < ACCOUNT_CACHE_SECONDS:
            stock = cached[1]
        else:
            result = await self._client().request("GET", "/api/v1/stocks", params={"symbols": code})
            stock = next((s for s in result if s["symbol"] == code), None)
            if not stock:
                raise TradingError(404, "stock-not-found", "종목 정보를 확인할 수 없습니다.")
            self._stocks[code] = time.monotonic(), stock
        if stock["market"] not in {"KOSPI", "KOSDAQ", "KR_ETC"} or stock["currency"] != "KRW":
            raise TradingError(422, "unsupported-market", "이 주문창은 국내 주식 지정가 주문을 지원합니다.")

    async def order(self, account: int, code: str, order_id: str) -> TossOrder:
        data = await self._client().request("GET", f"/api/v1/orders/{quote(order_id, safe='')}", account=account)
        order = TossOrder.model_validate(data)
        self._validate_order(account, code, order_id, order)
        return order

    def _validate_order(self, account: int, code: str, order_id: str, order: TossOrder) -> None:
        if order.orderId != order_id or order.symbol != code or order.currency != "KRW":
            raise TradingError(409, "order-context-mismatch", "선택한 종목의 국내 주식 주문만 변경할 수 있습니다.")
        remaining(order)  # Validate decimals before comparing them with event observations.
        observed = self._event_orders.get((account, order_id))
        if observed and (Decimal(order.execution.filledQuantity) < Decimal(observed.execution.filledQuantity)
                         or (observed.status in TERMINAL_STATES and order.status in EDITABLE_STATES)):
            raise TradingError(
                409, "order-state-syncing", "최신 체결·취소 내역을 동기화 중입니다. 갱신 후 다시 시도하세요."
            )

    async def review(self, command: TradingCommand) -> None:
        await self.authorize(command.account_seq)
        if command.command_id in self._commands or command.command_id in self._batches:
            raise TradingError(409, "order-processing", "아직 요청 처리 중입니다.")
        self.journal.review(command.command_id, command.account_seq, command.code)
        self.changed()

    def uncertain(self, account: int, code: str) -> list[str]:
        return [
            cid
            for cid in self.journal.unresolved(account, code)
            if cid not in self._commands and cid not in self._batches
        ]

    async def cancel_all(self, command: CancelTradingOrders) -> TradingCancelResponse:
        await self.authorize(command.account_seq)
        state, result = self.journal.begin(
            command.command_id, {**command.model_dump(), "action": "bulk", "order_id": ""}
        )
        if state == "accepted":
            return TradingCancelResponse.model_validate(result)
        task = self._batches.get(command.command_id)
        if task is not None:
            return await asyncio.shield(task)
        if state not in {"new", "batch"}:
            raise TradingError(409, "order-outcome-unknown", "전체 취소의 기존 처리 결과를 확인하세요.")
        task = asyncio.create_task(self._cancel_all(command, result if state == "batch" else None))
        self._batches[command.command_id] = task
        return await asyncio.shield(task)

    async def _cancel_all(self, command: CancelTradingOrders, saved: dict[str, Any] | None) -> TradingCancelResponse:
        try:
            # One fresh OPEN response provides the same fields as individual detail reads.
            # Never reuse the display cache or replay a persisted order snapshot on restart.
            data = await self._client().request(
                "GET", "/api/v1/orders", account=command.account_seq,
                params={"status": "OPEN", "symbol": command.code},
            )
            if data.get("hasNext"):
                raise TradingError(503, "invalid-toss-response", "전체 미체결 주문을 확인할 수 없습니다.")
            orders = {o.orderId: o for o in map(TossOrder.model_validate, data["orders"])}
            if saved is None:
                saved = {
                    "targets": [
                        {"id": o.orderId, "status": o.status}
                        for o in orders.values()
                        if command.side is None or o.side == command.side
                    ]
                }
                self.journal.finish(command.command_id, "batch", saved)  # Freeze targets BEFORE any cancel.

            async def cancel_target(target: dict[str, str]) -> TradingCancelResult:
                if target["status"] not in EDITABLE_STATES:
                    return TradingCancelResult(
                        order_id=target["id"], accepted=False, code="order-processing", message="이미 처리 중입니다.",
                    )
                child = TradingCommand(
                    account_seq=command.account_seq,
                    code=command.code,
                    command_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{command.command_id}:{target['id']}")),
                )
                try:
                    async with self._cancel_slots:
                        response = await self._command(
                            child, "cancel", target["id"], cancel_order=orders.get(target["id"]),
                        )
                    return TradingCancelResult(order_id=target["id"], accepted=True, operation_id=response.order_id)
                except TradingError as exc:
                    return TradingCancelResult(
                        order_id=target["id"], accepted=False, code=exc.code, message=exc.message,
                    )

            results = await asyncio.gather(*(cancel_target(target) for target in saved["targets"]))
            response = TradingCancelResponse(results=results)
            self.journal.finish(command.command_id, "accepted", response.model_dump())
            return response
        except TradingError as exc:
            if saved is None:
                self.journal.finish(
                    command.command_id, "rejected", {"status": exc.status, "code": exc.code, "message": exc.message}
                )
            raise
        finally:
            self._batches.pop(command.command_id, None)
            self.changed()

    async def execute(self, command: TradingCommand, action: str, order_id: str = "") -> TradingCommandResponse:
        await self.authorize(command.account_seq)
        return await self._command(command, action, order_id)

    async def _command(
        self, command: TradingCommand, action: str, order_id: str, *, cancel_order: TossOrder | None = None,
    ) -> TradingCommandResponse:
        payload = {**command.model_dump(), "action": action, "order_id": order_id}
        state, result = self.journal.begin(command.command_id, payload)
        if state == "accepted":
            return TradingCommandResponse.model_validate(result)
        if state == "rejected":
            assert result is not None
            raise TradingError(result["status"], result["code"], result["message"])
        if state != "new":
            task = self._commands.get(command.command_id)
            if task is not None:
                return await asyncio.shield(task)
            raise TradingError(
                409,
                "order-outcome-unknown",
                "같은 주문을 다시 전송하지 않았습니다. 토스증권 주문 내역에서 결과를 확인하세요.",
            )
        task = asyncio.create_task(self._execute(command, action, order_id, cancel_order=cancel_order))
        self._commands[command.command_id] = task
        return await asyncio.shield(task)

    async def _execute(
        self, command: TradingCommand, action: str, order_id: str, *, cancel_order: TossOrder | None = None,
    ) -> TradingCommandResponse:
        try:
            async with contextlib.AsyncExitStack() as stack:
                # New orders retain symbol serialization. Cancels of different orders
                # can overlap, but modify/cancel of the SAME order share one lock.
                if action != "cancel":
                    await stack.enter_async_context(self._locks[(command.account_seq, command.code)])
                if action != "create":
                    await stack.enter_async_context(self._order_locks[(command.account_seq, order_id)])
                response = await self._submit(command, action, order_id, cancel_order=cancel_order)
                self.journal.finish(command.command_id, "accepted", response.model_dump())
                return response
        except TradingError as exc:
            self.journal.finish(
                command.command_id,
                "unknown" if exc.code == "order-outcome-unknown" else "rejected",
                {"status": exc.status, "code": exc.code, "message": exc.message},
            )
            raise
        finally:
            self.changed()
            self._commands.pop(command.command_id, None)

    async def _submit(
        self, command: TradingCommand, action: str, order_id: str, *, cancel_order: TossOrder | None = None,
    ) -> TradingCommandResponse:
        client = self._client()
        account = command.account_seq
        if action == "create":
            assert isinstance(command, CreateTradingOrder)
            await self.domestic(command.code)
            unknown = [cid for cid in self.uncertain(account, command.code) if cid != command.command_id]
            if unknown:
                raise TradingError(
                    409, "unresolved-order-exists", "결과가 불명확한 주문이 있습니다. 토스증권 주문 내역을 확인하세요."
                )
            data = await client.request(
                "GET", "/api/v1/orders", account=account, params={"status": "OPEN", "symbol": command.code}
            )
            if any(o["side"] != command.side for o in data["orders"]):
                raise TradingError(
                    409,
                    "opposite-pending-order-exists",
                    "같은 종목의 반대 방향 미체결 주문을 먼저 취소하거나 체결 후 주문하세요.",
                )
            self._check_amount(command.price, command.quantity, command.confirm_high_value)
            path = "/api/v1/orders"
            body = {
                "clientOrderId": command.command_id,
                "symbol": command.code,
                "side": command.side,
                "orderType": "LIMIT",
                "timeInForce": "DAY",
                "quantity": str(command.quantity),
                "price": str(command.price),
                "confirmHighValueOrder": command.confirm_high_value,
            }
        else:
            if self.journal.uncertain_operation(command, order_id, set(self._commands)):
                raise TradingError(409, "unresolved-order-exists", "이 주문의 이전 정정·취소 결과를 먼저 확인하세요.")
            if action == "cancel" and cancel_order is not None:
                order = cancel_order
                self._validate_order(account, command.code, order_id, order)
            else:
                order = await self.order(account, command.code, order_id)
            if order.status not in EDITABLE_STATES or remaining(order) == 0:
                raise TradingError(
                    409, "order-not-editable", "이미 처리 중이거나 종료된 주문입니다. 주문 내역을 새로 확인하세요."
                )
            operation_id = self.journal.latest_operation(account, command.code, order_id)
            if operation_id:
                operation = await self.order(account, command.code, operation_id)
                if operation.status not in {"CANCEL_REJECTED", "REPLACE_REJECTED"}:
                    raise TradingError(409, "order-processing", "정정·취소 결과를 동기화 중입니다.")
            path = f"/api/v1/orders/{quote(order_id, safe='')}/{action}"
            body = {}
            if action == "modify":
                assert isinstance(command, ModifyTradingOrder)
                qty = command.quantity if command.quantity is not None else remaining(order)
                self._check_amount(command.price, qty, command.confirm_high_value)
                body = {
                    "orderType": "LIMIT",
                    "quantity": str(qty),
                    "price": str(command.price),
                    "confirmHighValueOrder": command.confirm_high_value,
                }
        result = await client.request("POST", path, account=account, body=body)
        if not isinstance(result.get("orderId"), str) or not result["orderId"]:
            raise TradingError(
                503, "order-outcome-unknown", "주문 식별자를 확인할 수 없습니다. 토스증권 주문 내역을 확인하세요."
            )
        return TradingCommandResponse(command_id=command.command_id, order_id=result["orderId"])

    @staticmethod
    def _check_amount(price: int, qty: int, confirmed: bool) -> None:
        if price * qty >= HIGH_VALUE_WON and not confirmed:
            raise TradingError(
                400, "confirm-high-value-required", "1억원 이상 주문입니다. 주문 금액을 확인한 뒤 접수하세요."
            )

    async def close(self) -> None:
        if self._batches:
            await asyncio.gather(*self._batches.values(), return_exceptions=True)
        if self._commands:
            await asyncio.gather(*self._commands.values(), return_exceptions=True)
        if self._events_task:
            self._events_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._events_task
        if self.client:
            await self.client.close()
