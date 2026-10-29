"""Resumable year-range stock lists from broker-reported trades, without synthetic fills."""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from datetime import datetime
from decimal import Decimal, InvalidOperation

from hoga.trading.chart_executions import ExecutionHistory
from hoga.trading.contracts import ExecutionHistoryRangePage, RecentTradedStock
from hoga.trading.executions import toss_orders_page, toss_row
from hoga.trading.kiwoom import code_of
from hoga.trading.toss import TradingError
from hoga.util.timeenc import KST

CACHE_LIMIT = 4096
DATE_LENGTH = 8


def parse_range(from_date: str, to_date: str):
    try:
        start, end = (datetime.strptime(value, "%Y%m%d").date() for value in (from_date, to_date))
        try:
            earliest = end.replace(year=end.year - 1)
        except ValueError:
            earliest = end.replace(year=end.year - 1, day=28)
        if not earliest <= start <= end or end > datetime.now(KST).date():
            raise ValueError("range")
    except ValueError as exc:
        raise TradingError(422, "invalid-history-range", "조회 기간은 오늘까지 최대 1년으로 선택하세요.") from exc


async def kiwoom_stocks(adapter, from_date: str, to_date: str, cursor: str | None):
    page, following = await adapter.gateway.call("kt00015", {
        "strt_dt": from_date, "end_dt": to_date, "tp": "3", "stk_cd": "", "crnc_cd": "KRW",
        "gds_tp": "1", "frgn_stex_code": "", "dmst_stex_tp": "%", "qry_sort_tp": "1",
    }, cursor=cursor or "")
    raw_rows = page.get("trst_ovrl_trde_prps_array")
    if (not isinstance(raw_rows, list) or any(not isinstance(row, dict) for row in raw_rows)
            or (following is not None and (not following or following == cursor))):
        raise adapter.gateway.failure(False)
    rows = []
    for raw in raw_rows:
        # Optional classification fields may be blank; the request also restricts domestic stock trades.
        if (str(raw.get("trde_ocr_tp") or "").strip() not in {"", "9", "09"}
                or str(raw.get("trde_prtc_tp") or "").strip() not in {"", "11"}):
            continue
        if str(raw.get("crnc_cd") or "").strip() not in {"", "KRW"}:
            continue
        try:
            quantity = Decimal(str(raw.get("trde_qty_jwa_cnt", "")))
            if not quantity.is_finite() or quantity != quantity.to_integral_value():
                raise ValueError("quantity")
        except (InvalidOperation, ValueError) as exc:
            raise TradingError(503, "invalid-trade-quantity", "과거 매매 수량을 확인할 수 없습니다.") from exc
        if quantity == 0:
            continue
        # cntr_dt is the fill date; trde_dt/proc_tm are ledger/processing observations.
        day = str(raw.get("cntr_dt", "")).strip()
        try:
            if len(day) != DATE_LENGTH or not day.isdigit():
                raise ValueError("date")
            datetime.strptime(day, "%Y%m%d")
        except ValueError as exc:
            raise TradingError(503, "missing-trade-date", "과거 매매일자를 확인할 수 없습니다.") from exc
        rows.append(RecentTradedStock(code=code_of(raw.get("stk_cd")),
            name=str(raw.get("stk_nm") or "").strip() or None, date=day, filled_at=None))
    return rows, following


async def toss_stocks(adapter, account: str, cursor: str | None):
    orders, following = await toss_orders_page(adapter, account, cursor)
    rows = []
    for order in orders:
        stamp = order.execution.filledAt or order.orderedAt
        day = datetime.fromisoformat(stamp).astimezone(KST).strftime("%Y%m%d")
        order_date = datetime.fromisoformat(order.orderedAt).astimezone(KST).strftime("%Y%m%d")
        row = toss_row(order, adapter.reference(account, order.orderId, order_date), day)
        if row:
            if not row.filled_at:
                raise TradingError(503, "missing-trade-date", "과거 매매일자를 확인할 수 없습니다.")
            rows.append(RecentTradedStock(code=row.code, name=row.name, date=day, filled_at=row.filled_at))
    return rows, following


class ExecutionHistoryRange:
    def __init__(self, data_dir):
        self.tokens = ExecutionHistory(data_dir)
        self.pages: OrderedDict[tuple, tuple[float, list[RecentTradedStock], str | None]] = OrderedDict()
        self.locks: dict[str, asyncio.Lock] = {}

    async def read(self, service, account: str, from_date: str, to_date: str, token: str | None):
        parse_range(from_date, to_date)
        scope = (account, from_date, to_date)
        cursor = self.tokens.decode(scope, token) if token else None
        adapter = await service.resolve(account)  # Authorize cached pages too.
        is_toss = adapter is service.toss
        if is_toss:
            service.legacy.start_events()
        else:
            await service.ensure_events(adapter)
        async with self.locks.setdefault(account, asyncio.Lock()):
            key = (*scope, cursor)
            ttl = 3 if not cursor else 300
            cached = self.pages.get(key)
            if cached and time.monotonic() - cached[0] < ttl:
                rows, following = cached[1:]
                self.pages.move_to_end(key)
            else:
                rows, following = await toss_stocks(adapter, account, cursor) if is_toss else await kiwoom_stocks(
                    adapter, from_date, to_date, cursor)
                self.pages[key] = time.monotonic(), rows, following
                while len(self.pages) > CACHE_LIMIT:
                    self.pages.popitem(last=False)
        unique: dict[str, RecentTradedStock] = {}
        def rank(row: RecentTradedStock):
            return row.date, datetime.fromisoformat(row.filled_at).timestamp() if row.filled_at else float("-inf")

        for row in rows:
            if from_date <= row.date <= to_date:
                old = unique.get(row.code)
                if old is None or rank(row) > rank(old):
                    unique[row.code] = row
        return ExecutionHistoryRangePage(
            account_ref=account, from_date=from_date, to_date=to_date, rows=list(unique.values()),
            next_key=self.tokens.cursor(scope, following) if following else None,
            scanned_through=min((row.date for row in rows), default=None),
            fetched_at_ms=int(time.time() * 1000),
            events_connected=service.legacy.events_connected if is_toss else adapter.events_connected,
        )
