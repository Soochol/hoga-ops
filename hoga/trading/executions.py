"""Account execution observations; market-data venue never filters this read path.

Rows are broker-reported order totals, not reconstructed individual executions.
In particular a Kiwoom execution price is not claimed to be an average price.
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
import time
from datetime import datetime
from decimal import Decimal

from hoga.trading.contracts import ExecutionHistoryPage, ExecutionHistoryRow
from hoga.trading.kiwoom import integer
from hoga.trading.models import TossOrder
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST


def cursor_value(token: str | None, account: str, date: str) -> str | None:
    if token is None:
        return None
    try:
        value = json.loads(base64.urlsafe_b64decode(token.encode()).decode())
        if value["account"] != account or value["date"] != date or not isinstance(value["cursor"], str):
            raise ValueError("cursor context")
        if not value["cursor"]:
            raise ValueError("empty cursor")
        return value["cursor"]
    except (ValueError, KeyError, TypeError, UnicodeError) as exc:
        raise TradingError(422, "invalid-history-cursor", "체결내역을 새로 조회하세요.") from exc


def next_token(cursor: str | None, account: str, date: str) -> str | None:
    if not cursor:
        return None
    return base64.urlsafe_b64encode(json.dumps({"account": account, "date": date, "cursor": cursor}).encode()).decode()


def toss_row(order: TossOrder, ref: str, date: str) -> ExecutionHistoryRow | None:
    filled = integer(order.execution.filledQuantity, optional=True)
    if not filled or int(filled) == 0 or not re.fullmatch(r"\d{6}", order.symbol) or order.currency != "KRW":
        return None
    # An order may fill on a later date; prefer the broker's execution date.
    stamp = order.execution.filledAt or order.orderedAt
    if datetime.fromisoformat(stamp).astimezone(KST).strftime("%Y%m%d") != date:
        return None
    return ExecutionHistoryRow(
        order_ref=ref, code=order.symbol, side=order.side, quantity=filled,
        order_quantity=order.quantity, price=order.execution.averageFilledPrice, price_basis="average",
        amount=order.execution.filledAmount, filled_at=order.execution.filledAt,
        ordered_at=order.orderedAt, route="SOR", broker_order_id=order.orderId,
    )


async def toss_page(
    adapter, account: str, date: str, cursor: str | None,
) -> tuple[list[ExecutionHistoryRow], str | None]:
    seq = await adapter.authorize(account)
    client = adapter.service._client()
    closed_params: dict = {"status": "CLOSED", "limit": 50}
    if cursor:
        closed_params["cursor"] = cursor
    requests = [client.request("GET", "/api/v1/orders", account=seq, params=closed_params)]
    if cursor is None:
        requests.append(client.request("GET", "/api/v1/orders", account=seq, params={"status": "OPEN"}))
    pages = await asyncio.gather(*requests)
    closed = pages[0]
    if len(pages) > 1 and pages[1].get("hasNext"):
        raise TradingError(503, "incomplete-order-history", "진행 중 주문 체결내역을 모두 조회하지 못했습니다.")
    following = closed.get("nextCursor") if closed.get("hasNext") else None
    if closed.get("hasNext") and (not isinstance(following, str) or not following or following == cursor):
        raise TradingError(503, "invalid-order-history", "이전 체결내역 조회를 완료하지 못했습니다.")
    rows = []
    for page in pages:
        if not isinstance(page.get("orders"), list):
            raise TradingError(503, "invalid-order-history", "체결내역 응답을 확인할 수 없습니다.")
        for raw in page["orders"]:
            order = TossOrder.model_validate(raw)
            # Bind using the actual order date, not the requested execution day.
            order_date = datetime.fromisoformat(order.orderedAt).astimezone(KST).strftime("%Y%m%d")
            row = toss_row(order, adapter.reference(account, order.orderId, order_date), date)
            if row:
                rows.append(row)
    return rows, following


async def kiwoom_page(adapter, date: str, cursor: str | None) -> tuple[list[ExecutionHistoryRow], str | None]:
    page, following = await adapter.gateway.call("kt00007", {
        "ord_dt": date, "qry_tp": "2", "stk_bond_tp": "1", "sell_tp": "0",
        "stk_cd": "", "fr_ord_no": "", "dmst_stex_tp": "%",
    }, cursor=cursor or "")
    raw_rows = page.get("acnt_ord_cntr_prps_dtl")
    if not isinstance(raw_rows, list) or any(not isinstance(row, dict) for row in raw_rows):
        raise adapter.gateway.failure(False)
    if following is not None and (not following or following == cursor):
        raise adapter.gateway.failure(False)
    rows = []
    for raw in raw_rows:
        filled = integer(raw.get("cntr_qty"), optional=True)
        if not filled or int(filled) == 0:
            continue
        order = adapter.parse_order(raw, date, history=True)
        # Cancellation confirmations cannot execute; their quantities may repeat
        # the parent. A modified order can execute and retains its own explicit fill.
        if order.operation == "cancel":
            continue
        price = integer(raw.get("cntr_uv"), optional=True)
        if price == "0":
            price = None
        amount = integer(raw.get("cntr_tot_amt"), optional=True)
        rows.append(ExecutionHistoryRow(
            order_ref=order.order_ref, broker_order_id=order.broker_order_id,
            code=order.code, name=str(raw.get("stk_nm", "")).strip() or None,
            side=order.side, quantity=filled, order_quantity=order.quantity,
            price=price, price_basis="execution", amount=amount,
            # ord_tm/cnfm_tm are order/confirmation clocks, never execution clocks.
            filled_at=None, ordered_at=order.ordered_at, route=order.route,
        ))
    return rows, following


async def execution_history(service, account: str, date: str, token: str | None) -> ExecutionHistoryPage:
    try:
        datetime.strptime(date, "%Y%m%d")
    except ValueError as exc:
        raise TradingError(422, "invalid-history-date", "조회 날짜를 확인하세요.") from exc
    cursor = cursor_value(token, account, date)
    adapter = await service.resolve(account)
    if adapter is service.toss:
        service.legacy.start_events()
        rows, following = await toss_page(adapter, account, date, cursor)
        connected = service.legacy.events_connected
    else:
        await service.ensure_events(adapter)
        rows, following = await kiwoom_page(adapter, date, cursor)
        connected = adapter.events_connected
    # Repeated pages or repeated snapshots of one order never become extra fills.
    unique: dict[str, ExecutionHistoryRow] = {}
    for row in rows:
        old = unique.get(row.order_ref)
        if old is None or Decimal(row.quantity) > Decimal(old.quantity):
            unique[row.order_ref] = row
    result = sorted(unique.values(),
                    key=lambda row: (row.filled_at or row.ordered_at or "", row.order_ref), reverse=True)
    return ExecutionHistoryPage(account_ref=account, date=date, rows=result,
                                next_key=next_token(following, account, date),
                                fetched_at_ms=int(time.time() * 1000), events_connected=connected)
