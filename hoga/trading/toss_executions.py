"""Toss order summaries: average filled price at the last fill time, never individual fills.

Official REST 1.2.24 / FAQ (2026-10-28): OPEN and CLOSED both contain fills;
date filters apply to orderedAt, not filledAt. Scan cursor pages and filter the
last fill date locally, sharing source pages across visible chart dates/venues.
"""

from __future__ import annotations

import hashlib
import time
from collections import OrderedDict
from datetime import datetime
from decimal import Decimal, InvalidOperation

from pydantic import ValidationError

from hoga.live import kiwoom_access, kiwoom_rest_runtime, settings
from hoga.trading.chart_executions import ExecutionHistory
from hoga.trading.contracts import AccountExecution, AccountExecutions
from hoga.trading.models import TossOrder
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST

SOURCE_CACHE_LIMIT = 256


def invalid_summary() -> TradingError:
    return TradingError(503, "invalid-toss-execution", "토스 주문의 평균 체결가·마지막 체결 시각을 확인할 수 없습니다.")


def parse_order_summary(raw: dict, adapter, ref: str, code: str) -> AccountExecution | None:
    try:
        order = TossOrder.model_validate(raw)
        quantity = Decimal(order.execution.filledQuantity)
        if order.symbol != code or order.currency != "KRW" or not quantity.is_finite() or quantity < 0:
            raise ValueError("invalid scope or quantity")
        if quantity == 0:
            return None
        price = Decimal(order.execution.averageFilledPrice or "")
        stamp = datetime.fromisoformat(order.execution.filledAt or "")
        ordered = datetime.fromisoformat(order.orderedAt)
        if (not order.orderId or not price.is_finite() or price <= 0 or quantity != quantity.to_integral_value()
                or stamp.tzinfo is None or ordered.tzinfo is None or stamp < ordered):
            raise ValueError("invalid price or fill time")
    except (ValueError, TypeError, InvalidOperation, ValidationError) as exc:
        raise invalid_summary() from exc
    date = stamp.astimezone(KST).strftime("%Y%m%d")
    order_date = ordered.astimezone(KST).strftime("%Y%m%d")
    digest = hashlib.sha256(f"{ref}:toss-order:{order.orderId}".encode()).hexdigest()
    return AccountExecution(
        execution_id=digest, order_ref=adapter.reference(ref, order.orderId, order_date), code=code,
        trading_date=date, t_ms=int(stamp.timestamp() * 1000), side=order.side,
        price=format(price, "f"), quantity=format(quantity, "f"), venue=None, basis="order_average",
    )


class TossExecutionHistory(ExecutionHistory):
    def __init__(self, data_dir):
        super().__init__(data_dir)
        self.data_dir = data_dir
        self.sources: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()

    async def page(self, client, seq: int, ref: str, code: str, status: str, cursor: str, ttl: int) -> dict:
        key = (ref, code, status, cursor)
        cached = self.sources.get(key)
        if cached and time.monotonic() - cached[0] < ttl:
            self.sources.move_to_end(key)
            return cached[1]
        params = {"status": status, "symbol": code}
        if status == "CLOSED":
            params["limit"] = 100
            if cursor:
                params["cursor"] = cursor
        data = await client.request("GET", "/api/v1/orders", account=seq, params=params)
        if (not isinstance(data, dict) or not isinstance(data.get("orders"), list)
                or any(not isinstance(row, dict) for row in data["orders"])
                or not isinstance(data.get("hasNext"), bool)
                or (status == "OPEN" and data["hasNext"])
                or (data["hasNext"] and (not isinstance(data.get("nextCursor"), str)
                    or not data["nextCursor"] or data["nextCursor"] == cursor))):
            raise invalid_summary()
        self.sources[key] = time.monotonic(), data
        while len(self.sources) > SOURCE_CACHE_LIMIT:
            self.sources.popitem(last=False)
        return data

    async def quote_original_close(self, code: str, date: str, venue: str) -> str | None:
        # Match the chart's own venue/source; another broker's closing price is not a factor.
        if settings.rest_bypass_enabled(self.data_dir):
            return None
        client = kiwoom_rest_runtime.ensure_rest_client(self.data_dir)
        if client is None:
            return None
        scheduler = kiwoom_rest_runtime.ensure_scheduler(self.data_dir)
        suffix = {"KRX": "", "NXT": "_NX", "UN": "_AL"}[venue]
        page = await kiwoom_access.run_with_capacity(
            scheduler, key=("execution-raw-close", code, date, venue), api_id="ka10081",
            priority="user_visible", client=client,
            fetch_fn=lambda picked: picked.call("ka10081", {
                "stk_cd": code + suffix, "base_dt": date, "upd_stkpc_tp": "0",
            }),
        )
        for bar in page.rows:
            if bar.get("dt") == date:
                try:
                    value = Decimal(str(bar.get("cur_prc", "")).lstrip("+-"))
                except InvalidOperation as exc:
                    raise invalid_summary() from exc
                return format(value, "f") if value.is_finite() and value > 0 else None
        return None

    async def read(self, adapter, ref: str, code: str, date: str, cursor: str | None, venue: str) -> AccountExecutions:
        scope = (ref, code, date + ":" + venue)
        native = self.decode(scope, cursor) if cursor else ""
        key = (*scope, native)
        today = datetime.now(KST).strftime("%Y%m%d")
        ttl = 5 if date == today else 300
        async with self.lock:
            cached = self.cache.get(key)
            if cached and time.monotonic() - cached[0] < ttl:
                self.cache.move_to_end(key)
                return cached[1]
            seq = adapter.accounts_by_ref[ref]  # BrokerTradingService.resolve has just authorized this binding.
            client = adapter.service._client()
            closed = await self.page(client, seq, ref, code, "CLOSED", native, ttl)
            opened = await self.page(client, seq, ref, code, "OPEN", "", ttl) if not cursor else {"orders": []}
            rows: dict[str, AccountExecution] = {}
            # If a transition appears in both lists, prefer the largest cumulative filled quantity.
            for raw in [*closed["orders"], *opened["orders"]]:
                row = parse_order_summary(raw, adapter, ref, code)
                if row is None:
                    continue
                previous = rows.get(row.execution_id)
                if previous is None or (Decimal(row.quantity), row.t_ms) >= (Decimal(previous.quantity), previous.t_ms):
                    rows[row.execution_id] = row
            selected = sorted((r for r in rows.values() if r.trading_date == date),
                              key=lambda r: (r.t_ms, r.execution_id))
            raw_close = next((r.raw_close for k, (_age, r) in self.cache.items()
                              if k[:3] == scope and r.raw_close is not None), None)
            if selected and date < today and raw_close is None:
                raw_close = await self.quote_original_close(code, date, venue)
            # Aggregates are mutable: don't archive snapshots as immutable individual fills.
            next_cursor = self.cursor(scope, closed["nextCursor"]) if closed["hasNext"] else None
            result = AccountExecutions(account_ref=ref, code=code, date=date, rows=selected, next_cursor=next_cursor,
                                       fetched_at_ms=int(time.time() * 1000), raw_close=raw_close, price_venue=venue)
            self.cache[key] = time.monotonic(), result
            while len(self.cache) > SOURCE_CACHE_LIMIT:
                self.cache.popitem(last=False)
            return result
