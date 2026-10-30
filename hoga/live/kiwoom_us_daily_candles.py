"""Kiwoom US stock daily adapter; vendor continuation headers, USD prices."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime

from hoga.live import kiwoom_access
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.us_daily_candles import NY, UsDateRange, UsFetchResult, parse_bar, parse_date, shift

EXCHANGE_CODES = {"NASDAQ": "ND", "NYSE": "NY", "AMEX": "NA"}
_FIELDS = ("dt", "open_pric", "high_pric", "low_pric", "cur_prc", "acc_trde_qty")
MAX_CHECKPOINTS = 512


@dataclass
class StockDailyWalk:
    """Cursor checkpoints for one immutable USD adjustment anchor; no price cache."""

    adjusted_as_of: str
    checkpoints: dict[str, str] = field(default_factory=dict)

    def remember(self, oldest, next_key):
        self.checkpoints[oldest] = next_key
        if len(self.checkpoints) > MAX_CHECKPOINTS:
            del self.checkpoints[max(self.checkpoints)]


class StockDailyWalks:
    def __init__(self, limit=128):
        self.limit = limit
        self.entries: OrderedDict[tuple[str, str, str], StockDailyWalk] = OrderedDict()

    def get(self, exchange, symbol, anchor):
        key = (exchange, symbol, anchor)
        walk = self.entries.setdefault(key, StockDailyWalk(anchor))
        self.entries.move_to_end(key)
        while len(self.entries) > self.limit:
            self.entries.popitem(last=False)
        return walk


def validated_page(page, anchor, end, previous_oldest, keys, seen):
    if page.raw.get("return_code") != 0 or not isinstance(page.raw.get("result_list"), list):
        raise ValueError("invalid Kiwoom US daily envelope")
    days = [str(r["dt"]).strip() for r in page.rows]
    for day in days:
        parse_date(day)
    if any(day > anchor for day in days):
        raise ValueError("Kiwoom strt_dt is not an upper bound")
    # The anchor's provisional bar can have an inconsistent premarket OHLC.
    # Completed history must still walk past it, without publishing/fixing it.
    bars = [parse_bar(r, fields=_FIELDS) for r, day in zip(page.rows, days, strict=True) if day <= end]
    oldest = min(days, default=None)
    if previous_oldest and oldest and oldest >= previous_oldest:
        raise ValueError("Kiwoom daily cursor did not advance")
    if page.cont and (not oldest or not page.next_key or page.next_key in keys):
        raise ValueError("invalid Kiwoom continuation")
    accepted = {}
    for bar in bars:
        existing = accepted.get(bar.trading_date, seen.get(bar.trading_date))
        if existing is not None and existing != bar:
            raise ValueError("conflicting Kiwoom daily prices")
        accepted[bar.trading_date] = bar
    return accepted.values(), oldest


async def fetch_stock_daily(
    client,
    scheduler,
    exchange: str,
    symbol: str,
    start: str,
    end: str,
    *,
    max_pages: int = 8,
    budget_seconds: float = 15,
    adjusted_as_of: str | None = None,
    walk: StockDailyWalk | None = None,
) -> UsFetchResult:
    anchor = adjusted_as_of or datetime.now(NY).strftime("%Y%m%d")
    parse_date(anchor)
    if end > anchor or (walk and walk.adjusted_as_of != anchor):
        raise ValueError("inconsistent US daily adjustment anchor")
    # strt_dt controls BOTH the page upper bound and the adjustment basis. Never
    # move it to a historical viewport boundary; only advance vendor cursors.
    body = {
        "stex_tp": EXCHANGE_CODES[exchange],
        "stk_cd": symbol,
        "strt_dt": anchor,
        "upd_stkpc_tp": "1",
        "exrt_appl_tp": "0",
    }
    result = UsFetchResult()
    next_key = ""
    previous_oldest = None
    cursor = anchor
    if walk:
        boundary = min((d for d in walk.checkpoints if d > end), default=None)
        if boundary:
            next_key = walk.checkpoints[boundary]
            previous_oldest = boundary
            cursor = shift(boundary, -1)
    seen = {}
    keys = {next_key} if next_key else set()
    deadline = time.monotonic() + budget_seconds
    for _ in range(max_pages):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break

            async def call(c, token=next_key):
                return await c.call("usa06012", body, cont=bool(token), next_key=token)

            page = await asyncio.wait_for(
                kiwoom_access.run_with_capacity(
                    scheduler,
                    key=("us-stock-daily", exchange, symbol, anchor, "adjusted-USD", next_key),
                    api_id="usa06012",
                    priority="user_visible",
                    fetch_fn=call,
                    client=client,
                ),
                remaining,
            )
            # Validate the whole page before publishing its rows or coverage.
            bars, oldest = validated_page(page, anchor, end, previous_oldest, keys, seen)
            for bar in bars:
                if start <= bar.trading_date <= end:
                    seen.setdefault(bar.trading_date, bar)
            left = max(start, oldest) if oldest and page.cont else start
            if left <= min(end, cursor):
                result.completed.append(UsDateRange(start=left, end=min(end, cursor)))
            if walk and page.cont:
                walk.remember(oldest, page.next_key)
            if not page.cont or oldest <= start:
                cursor = shift(start, -1)
                break
            cursor = shift(oldest, -1)
            previous_oldest = oldest
            next_key = page.next_key
            keys.add(next_key)
        except (KiwoomRestError, KiwoomCapacityOverloaded, TimeoutError, ValueError, KeyError, TypeError) as exc:
            if walk:
                # Expired/rejected continuations can be rebuilt on retry.
                walk.checkpoints.clear()
            result.messages.append(f"Kiwoom US daily page incomplete: {type(exc).__name__}")
            break
    result.bars = sorted(seen.values(), key=lambda b: b.trading_date)
    result.truncated = cursor >= start
    return result
