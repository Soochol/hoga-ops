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
    TradingCancelResponse,
    TradingCancelResult,
    TradingCommand,
    TradingCommandResponse,
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
        self, data_dir: Path, client: TossClient | None = None, on_change: Callable[[int], None] | None = None
    ) -> None:
        self.client = client
        self.journal = CommandJournal(data_dir / "trading" / "commands.sqlite3")
        self._accounts: list[dict[str, Any]] = []
        self._accounts_at = 0.0
        self._accounts_lock = asyncio.Lock()
        self._locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._state_locks: defaultdict[tuple[int, str], asyncio.Lock] = defaultdict(asyncio.Lock)
        self._snapshots: dict[tuple[int, str], tuple[float, TradingStateResponse]] = {}
        self._holdings: dict[int, tuple[float, list[dict[str, Any]]]] = {}
        self._holding_locks: defaultdict[int, asyncio.Lock] = defaultdict(asyncio.Lock)
        self._stocks: dict[str, tuple[float, dict[str, Any]]] = {}
        self._commands: dict[str, asyncio.Task[TradingCommandResponse]] = {}
        self._batches: dict[str, asyncio.Task[TradingCancelResponse]] = {}
        self._events_task: asyncio.Task[None] | None = None
        self.events_connected = False
        self.revision = 0
        self.on_change = on_change

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

    def changed(self) -> None:
        self._snapshots.clear()
        self._holdings.clear()
        self.revision += 1
        if self.on_change:
            self.on_change(self.revision)

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
                            self.changed()  # Fetch canonical REST state; do not reorder partial event snapshots.
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
        await self.authorize(account)
        self.start_events()
        key = (account, code)
        async with self._state_locks[key]:
            cached = self._snapshots.get(key)
            if cached and time.monotonic() - cached[0] < STATE_CACHE_SECONDS:
                return cached[1]
            client = self._client()
            revision = self.revision
            open_data, closed_data, power, sellable, holdings = await asyncio.gather(
                client.request("GET", "/api/v1/orders", account=account, params={"status": "OPEN", "symbol": code}),
                client.request(
                    "GET", "/api/v1/orders", account=account, params={"status": "CLOSED", "symbol": code, "limit": 10}
                ),
                client.request("GET", "/api/v1/buying-power", account=account, params={"currency": "KRW"}),
                client.request("GET", "/api/v1/sellable-quantity", account=account, params={"symbol": code}),
                self.holdings(account),
            )
            holding = next((h for h in holdings if h["symbol"] == code), None)
            result = TradingStateResponse(
                account_seq=account,
                code=code,
                orders=[TossOrder.model_validate(o) for o in open_data["orders"]],
                recent_orders=[TossOrder.model_validate(o) for o in closed_data["orders"]],
                buying_power=power["cashBuyingPower"],
                sellable_quantity=sellable["sellableQuantity"],
                holding_quantity=holding["quantity"] if holding else "0",
                average_purchase_price=holding["averagePurchasePrice"] if holding else None,
                fetched_at_ms=int(time.time() * 1000),
                events_connected=self.events_connected,
                unresolved_commands=self.uncertain(account, code),
            )
            if revision == self.revision:
                self._snapshots[key] = time.monotonic(), result
            return result

    async def holdings(self, account: int) -> list[dict[str, Any]]:
        async with self._holding_locks[account]:
            cached = self._holdings.get(account)
            if cached and time.monotonic() - cached[0] < HOLDINGS_CACHE_SECONDS:
                return cached[1]
            result = await self._client().request("GET", "/api/v1/holdings", account=account)
            items = result["items"]
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
        if order.orderId != order_id or order.symbol != code or order.currency != "KRW":
            raise TradingError(409, "order-context-mismatch", "선택한 종목의 국내 주식 주문만 변경할 수 있습니다.")
        return order

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
            if saved is None:
                snapshot = await self.state(command.account_seq, command.code)
                saved = {
                    "targets": [
                        {"id": o.orderId, "status": o.status}
                        for o in snapshot.orders
                        if command.side is None or o.side == command.side
                    ]
                }
                self.journal.finish(command.command_id, "batch", saved)  # Freeze targets BEFORE any cancel.
            results: list[TradingCancelResult] = []
            for target in saved["targets"]:
                if target["status"] not in EDITABLE_STATES:
                    results.append(
                        TradingCancelResult(
                            order_id=target["id"],
                            accepted=False,
                            code="order-processing",
                            message="이미 처리 중입니다.",
                        )
                    )
                    continue
                child = TradingCommand(
                    account_seq=command.account_seq,
                    code=command.code,
                    command_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{command.command_id}:{target['id']}")),
                )
                try:
                    response = await self.execute(child, "cancel", target["id"])
                    results.append(
                        TradingCancelResult(order_id=target["id"], accepted=True, operation_id=response.order_id)
                    )
                except TradingError as exc:
                    results.append(
                        TradingCancelResult(order_id=target["id"], accepted=False, code=exc.code, message=exc.message)
                    )
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
        task = asyncio.create_task(self._execute(command, action, order_id))
        self._commands[command.command_id] = task
        return await asyncio.shield(task)

    async def _execute(self, command: TradingCommand, action: str, order_id: str) -> TradingCommandResponse:
        try:
            async with self._locks[(command.account_seq, command.code)]:
                response = await self._submit(command, action, order_id)
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

    async def _submit(self, command: TradingCommand, action: str, order_id: str) -> TradingCommandResponse:
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
