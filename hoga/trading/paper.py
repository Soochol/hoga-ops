"""Local cash account. Consumes the integrated live book, never a broker API.

For known NXT exclusions, the integrated book is the KRX book.

Price/time priority within this account; displayed liquidity is shared by all
orders and only replenished by positive depth changes. No exchange queue,
fees, auctions, or invented fills when the live feed is missing/stale.
"""

from __future__ import annotations

import asyncio
import contextlib
import copy
import json
import logging
import sqlite3
import time
from collections.abc import Awaitable, Callable
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from hoga.trading.models import (
    CancelTradingOrders,
    CreateTradingOrder,
    ModifyTradingOrder,
    ResetPaperAccount,
    TossOrder,
    TradingAccount,
    TradingAccountsResponse,
    TradingBalancesResponse,
    TradingCancelResponse,
    TradingCancelResult,
    TradingCommand,
    TradingCommandResponse,
    TradingOrderStateResponse,
    TradingStateResponse,
)
from hoga.trading.service import TradingService
from hoga.trading.toss import TradingError

log = logging.getLogger(__name__)
OPEN = {"PENDING", "PARTIAL_FILLED"}
FRESH_BOOK_MS = 30_000
FUTURE_TOLERANCE_MS = 5_000
KST = ZoneInfo("Asia/Seoul")
BookGetter = Callable[[str], Awaitable[dict | None]]


def timestamp() -> str:
    return datetime.now(KST).isoformat()


def remainder(order: dict) -> int:
    return int(order["quantity"]) - int(order["execution"]["filledQuantity"])


class PaperTradingService:
    def __init__(self, data_dir: Path, book_getter: BookGetter, on_change: Callable[[int], None] | None = None):
        self.path = data_dir / "trading" / "paper.sqlite3"
        self.book_getter = book_getter
        self.on_change = on_change
        self.revision = 0
        self.lock = asyncio.Lock()  # Account-wide: buying power is shared across Codes.
        self.task: asyncio.Task | None = None
        self.doc: dict[str, Any] | None = None

    def _load(self) -> dict:
        if self.doc is None:
            if self.path.exists():
                with contextlib.closing(sqlite3.connect(self.path)) as db:
                    row = db.execute("SELECT document FROM account WHERE id=1").fetchone()
                self.doc = json.loads(row[0]) if row else None
            if self.doc is None:
                self.doc = {
                    "cash": 100_000_000,
                    "holdings": {},
                    "orders": [],
                    "commands": {},
                    "books": {},
                    "sequence": 0,
                }
        return self.doc

    def _save(self, doc: dict) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with contextlib.closing(sqlite3.connect(self.path)) as db, db:
            db.execute("CREATE TABLE IF NOT EXISTS account (id INTEGER PRIMARY KEY, document TEXT NOT NULL)")
            db.execute("INSERT OR REPLACE INTO account VALUES (1, ?)", (json.dumps(doc),))
        self.doc = doc  # Publish only after the atomic commit succeeds.
        self.revision += 1
        if self.on_change:
            self.on_change(self.revision)

    def start(self) -> None:
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self._loop(), name="paper-trading")

    async def _loop(self) -> None:
        while True:
            try:
                async with self.lock:
                    doc = copy.deepcopy(self._load())
                    codes = {o["symbol"] for o in doc["orders"] if o["status"] in OPEN}
                    changed = False
                    for code in codes:
                        changed = await self._reconcile(doc, code) or changed
                    if changed:
                        self._save(doc)
            except Exception:
                log.exception("paper-trading.reconcile-failed")
            await asyncio.sleep(1)

    @staticmethod
    def authorize(account: int) -> None:
        if account != 1:
            raise TradingError(403, "paper-account-not-found", "로컬 모의 계좌를 선택하세요.")

    async def accounts(self) -> TradingAccountsResponse:
        self.start()
        return TradingAccountsResponse(
            configured=True, accounts=[TradingAccount(account_seq=1, label="로컬 모의 계좌")]
        )

    @staticmethod
    def _fresh(book: dict | None) -> bool:
        return bool(book and -FUTURE_TOLERANCE_MS <= time.time() * 1000 - book["t_ms"] < FRESH_BOOK_MS)

    async def _book(self, code: str, required: bool = False) -> dict | None:
        book = await self.book_getter(code)
        if not self._fresh(book):
            if required:
                raise TradingError(
                    409, "paper-book-stale", "실시간 통합 호가가 없거나 오래되었습니다. 갱신 후 주문하세요."
                )
            return None
        asks = {
            int(level["price"]): int(level["qty"])
            for level in book.get("asks", [])
            if level["price"] > 0 and level["qty"] >= 0
        }
        bids = {
            int(level["price"]): int(level["qty"])
            for level in book.get("bids", [])
            if level["price"] > 0 and level["qty"] >= 0
        }
        if not asks or not bids or max(bids) >= min(asks):
            if required:
                raise TradingError(
                    409,
                    "paper-book-unavailable",
                    "양방향 호가가 필요합니다. 교차 호가는 체결하지 않습니다.",
                )
            return None
        return {"t_ms": book["t_ms"], "asks": asks, "bids": bids}

    async def _reconcile(self, doc: dict, code: str, required: bool = False) -> bool:
        expired = False
        today = datetime.now(KST).date()
        for order in doc["orders"]:
            if order["status"] in OPEN and datetime.fromisoformat(order["orderedAt"]).astimezone(KST).date() < today:
                order["status"] = "EXPIRED"
                order["canceledAt"] = timestamp()
                expired = True
        book = await self._book(code, required)
        if book is None:
            return expired
        key = code
        previous = doc["books"].get(key)
        # Out-of-order/restored snapshots never mint new liquidity.
        if previous and book["t_ms"] < previous["t_ms"]:
            if required:
                raise TradingError(
                    409, "paper-book-regressed", "호가 시각이 이전으로 돌아갔습니다. 새 호가를 기다리세요."
                )
            return False
        normalized = {side: {str(p): q for p, q in book[side].items()} for side in ("asks", "bids")}
        changed = (
            not previous
            or any(previous[side]["depth"] != normalized[side] for side in normalized)
            or previous["t_ms"] != book["t_ms"]
        )
        if changed:
            levels = {"t_ms": book["t_ms"]}
            for side, depth in normalized.items():
                old = previous[side] if previous else {"depth": {}, "available": {}}
                available = {
                    p: min(q, max(0, old["available"].get(p, 0) + q - old["depth"].get(p, 0))) for p, q in depth.items()
                }
                levels[side] = {"depth": depth, "available": available}
            doc["books"][key] = levels
        return self._match(doc, code) or changed or expired

    @staticmethod
    def _match(doc: dict, code: str) -> bool:
        book = doc["books"].get(code)
        if not book:
            return False
        changed = False
        for side, depth_side in (("BUY", "asks"), ("SELL", "bids")):
            pending = [o for o in doc["orders"] if o["symbol"] == code and o["side"] == side and o["status"] in OPEN]
            pending.sort(key=lambda o: (-int(o["price"]) if side == "BUY" else int(o["price"]), o["sequence"]))
            available = book[depth_side]["available"]
            for order in pending:
                for price in sorted(available, key=int, reverse=side == "SELL"):
                    p = int(price)
                    limit = int(order["price"])
                    if (side == "BUY" and p > limit) or (side == "SELL" and p < limit):
                        break
                    qty = min(remainder(order), available[price])
                    if qty <= 0:
                        continue
                    available[price] -= qty
                    execution = order["execution"]
                    filled = int(execution["filledQuantity"]) + qty
                    amount = int(execution.get("filledAmount") or 0) + p * qty
                    execution.update(
                        filledQuantity=str(filled),
                        filledAmount=str(amount),
                        averageFilledPrice=str(Decimal(amount) / filled),
                        filledAt=timestamp(),
                    )
                    holding = doc["holdings"].setdefault(code, {"quantity": 0, "cost": "0"})
                    if side == "BUY":
                        holding["quantity"] += qty
                        holding["cost"] = str(Decimal(holding["cost"]) + p * qty)
                        doc["cash"] -= p * qty
                    else:
                        old_qty = holding["quantity"]
                        holding["quantity"] -= qty
                        holding["cost"] = str(Decimal(holding["cost"]) * holding["quantity"] / old_qty)
                        doc["cash"] += p * qty
                    order["status"] = "FILLED" if remainder(order) == 0 else "PARTIAL_FILLED"
                    changed = True
                    if remainder(order) == 0:
                        break
        return changed

    @staticmethod
    def _power(doc: dict) -> int:
        reserved = sum(
            int(o["price"]) * remainder(o) for o in doc["orders"] if o["side"] == "BUY" and o["status"] in OPEN
        )
        return doc["cash"] - reserved

    @staticmethod
    def _sellable(doc: dict, code: str) -> int:
        reserved = sum(
            remainder(o) for o in doc["orders"] if o["symbol"] == code and o["side"] == "SELL" and o["status"] in OPEN
        )
        return doc["holdings"].get(code, {}).get("quantity", 0) - reserved

    def _state(self, doc: dict, code: str) -> TradingStateResponse:
        holding = doc["holdings"].get(code, {"quantity": 0, "cost": "0"})
        orders = [o for o in doc["orders"] if o["symbol"] == code]
        return TradingStateResponse(
            account_seq=1,
            code=code,
            orders=[TossOrder.model_validate(o) for o in orders if o["status"] in OPEN],
            recent_orders=[TossOrder.model_validate(o) for o in reversed(orders) if o["status"] not in OPEN][:10],
            buying_power=str(self._power(doc)),
            sellable_quantity=str(self._sellable(doc, code)),
            holding_quantity=str(holding["quantity"]),
            average_purchase_price=str(Decimal(holding["cost"]) / holding["quantity"]) if holding["quantity"] else None,
            fetched_at_ms=int(time.time() * 1000),
            events_connected=False,
        )

    async def state(self, account: int, code: str) -> TradingStateResponse:
        self.authorize(account)
        self.start()
        async with self.lock:
            doc = copy.deepcopy(self._load())
            if await self._reconcile(doc, code):
                self._save(doc)
            return self._state(doc, code)

    async def order_state(self, account: int, code: str) -> TradingOrderStateResponse:
        return TradingOrderStateResponse.model_validate((await self.state(account, code)).model_dump())

    async def balances(self, account: int, code: str) -> TradingBalancesResponse:
        return TradingBalancesResponse.model_validate((await self.state(account, code)).model_dump())

    @staticmethod
    def _cached(doc: dict, command: TradingCommand, action: str, order_id: str = "") -> tuple[dict, dict | None]:
        payload = {**command.model_dump(), "action": action, "order_id": order_id}
        old = doc["commands"].get(command.command_id)
        if old and old["payload"] != payload:
            raise TradingError(409, "command-id-conflict", "같은 요청 식별자로 다른 주문을 보낼 수 없습니다.")
        return payload, old["result"] if old else None

    @staticmethod
    def _new(doc: dict, code: str, side: str, price: int, qty: int) -> dict:
        doc["sequence"] += 1
        order = TossOrder(
            orderId=f"paper-{doc['sequence']}",
            symbol=code,
            side=side,
            price=str(price),
            quantity=str(qty),
            orderType="LIMIT",
            timeInForce="DAY",
            status="PENDING",
            currency="KRW",
            orderedAt=timestamp(),
            execution={"filledQuantity": "0"},
        ).model_dump()
        order["sequence"] = doc["sequence"]
        doc["orders"].append(order)
        return order

    @staticmethod
    def _order(doc: dict, code: str, order_id: str) -> dict:
        order = next((o for o in doc["orders"] if o["orderId"] == order_id and o["symbol"] == code), None)
        if not order or order["status"] not in OPEN:
            raise TradingError(409, "order-not-editable", "이미 종료되었거나 선택한 종목의 주문이 아닙니다.")
        return order

    @staticmethod
    def _reserve(doc: dict, code: str, side: str, price: int, qty: int) -> None:
        if side == "BUY" and price * qty > PaperTradingService._power(doc):
            raise TradingError(409, "paper-insufficient-cash", "모의 계좌의 매수 가능 금액이 부족합니다.")
        if side == "SELL" and qty > PaperTradingService._sellable(doc, code):
            raise TradingError(409, "paper-insufficient-holdings", "모의 계좌의 매도 가능 수량이 부족합니다.")

    async def execute(self, command: TradingCommand, action: str, order_id: str = "") -> TradingCommandResponse:
        self.authorize(command.account_seq)
        self.start()
        async with self.lock:
            doc = copy.deepcopy(self._load())
            payload, cached = self._cached(doc, command, action, order_id)
            if cached is not None:
                return TradingCommandResponse.model_validate(cached)
            # Reconcile fills BEFORE deciding which remainder can be moved/canceled.
            if await self._reconcile(doc, command.code, required=action != "cancel"):
                self._save(doc)
                doc = copy.deepcopy(doc)
            if action == "create":
                assert isinstance(command, CreateTradingOrder)
                if any(
                    o["symbol"] == command.code and o["side"] != command.side and o["status"] in OPEN
                    for o in doc["orders"]
                ):
                    raise TradingError(409, "opposite-pending-order-exists", "반대 방향 미체결 주문을 먼저 취소하세요.")
                TradingService._check_amount(command.price, command.quantity, command.confirm_high_value)
                self._reserve(doc, command.code, command.side, command.price, command.quantity)
                order = self._new(doc, command.code, command.side, command.price, command.quantity)
                self._match(doc, command.code)
                result_id = order["orderId"]
            else:
                order = self._order(doc, command.code, order_id)
                if action == "cancel":
                    order["status"] = "CANCELED"
                    order["canceledAt"] = timestamp()
                    result_id = order_id
                else:
                    assert action == "modify" and isinstance(command, ModifyTradingOrder)
                    qty = command.quantity if command.quantity is not None else remainder(order)
                    TradingService._check_amount(command.price, qty, command.confirm_high_value)
                    order["status"] = "REPLACED"  # Releases the old reservation; fills remain in history.
                    self._reserve(doc, command.code, order["side"], command.price, qty)
                    new = self._new(doc, command.code, order["side"], command.price, qty)
                    self._match(doc, command.code)
                    result_id = new["orderId"]
            result = TradingCommandResponse(command_id=command.command_id, order_id=result_id)
            doc["commands"][command.command_id] = {"payload": payload, "result": result.model_dump()}
            self._save(doc)
            return result

    async def cancel_all(self, command: CancelTradingOrders) -> TradingCancelResponse:
        self.authorize(command.account_seq)
        async with self.lock:
            doc = copy.deepcopy(self._load())
            payload, cached = self._cached(doc, command, "bulk")
            if cached is not None:
                return TradingCancelResponse.model_validate(cached)
            await self._reconcile(doc, command.code)
            results = []
            for order in doc["orders"]:
                if (
                    order["symbol"] == command.code
                    and order["status"] in OPEN
                    and (command.side is None or order["side"] == command.side)
                ):
                    order["status"] = "CANCELED"
                    order["canceledAt"] = timestamp()
                    results.append(
                        TradingCancelResult(order_id=order["orderId"], accepted=True, operation_id=order["orderId"])
                    )
            result = TradingCancelResponse(results=results)
            doc["commands"][command.command_id] = {"payload": payload, "result": result.model_dump()}
            self._save(doc)
            return result

    async def review(self, command: TradingCommand) -> None:
        self.authorize(command.account_seq)
        raise TradingError(409, "paper-review-not-needed", "모의 계좌에는 결과 불명확 요청이 없습니다.")

    async def reset(self, command: ResetPaperAccount) -> TradingStateResponse:
        self.authorize(command.account_seq)
        async with self.lock:
            doc = copy.deepcopy(self._load())
            payload, cached = self._cached(doc, command, "reset")
            if cached is not None:
                return TradingStateResponse.model_validate(cached)
            doc["cash"] = command.cash
            doc["holdings"] = {
                command.code: {
                    "quantity": command.holding_quantity,
                    "cost": str(command.holding_quantity * command.average_purchase_price),
                }
            }
            doc["orders"] = []
            # Keep command IDs and depleted books: late retries do not create trades.
            result = self._state(doc, command.code)
            doc["commands"][command.command_id] = {"payload": payload, "result": result.model_dump()}
            self._save(doc)
            return result

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
