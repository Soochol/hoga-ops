"""Kiwoom US stock daily adapter; vendor continuation headers, USD prices."""

from __future__ import annotations

import asyncio
import time

from hoga.live import kiwoom_access
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.us_daily_candles import UsDateRange, UsFetchResult, parse_bar, shift

EXCHANGE_CODES = {"NASDAQ": "ND", "NYSE": "NY", "AMEX": "NA"}
_FIELDS = ("dt", "open_pric", "high_pric", "low_pric", "cur_prc", "acc_trde_qty")


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
) -> UsFetchResult:
    # Raw price basis is explicit until split-adjusted anchor invariance is verified.
    body = {
        "stex_tp": EXCHANGE_CODES[exchange],
        "stk_cd": symbol,
        "strt_dt": end,
        "upd_stkpc_tp": "0",
        "exrt_appl_tp": "0",
    }
    result = UsFetchResult()
    next_key = ""
    previous_oldest = None
    cursor = end
    seen = {}
    keys = set()
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
                    key=("us-stock-daily", exchange, symbol, end, "raw-USD", next_key),
                    api_id="usa06012",
                    priority="user_visible",
                    fetch_fn=call,
                    client=client,
                ),
                remaining,
            )
            if page.raw.get("return_code") != 0 or not isinstance(page.raw.get("result_list"), list):
                raise ValueError("invalid Kiwoom US daily envelope")
            bars = [parse_bar(r, fields=_FIELDS) for r in page.rows]
            if any(b.trading_date > end for b in bars):
                raise ValueError("Kiwoom strt_dt is not an upper bound")
            oldest = min((b.trading_date for b in bars), default=None)
            if previous_oldest and oldest and oldest >= previous_oldest:
                raise ValueError("Kiwoom daily cursor did not advance")
            if page.cont and (not oldest or not page.next_key or page.next_key in keys):
                raise ValueError("invalid Kiwoom continuation")
            for bar in bars:
                if start <= bar.trading_date <= end:
                    seen.setdefault(bar.trading_date, bar)
            left = max(start, oldest) if oldest and page.cont else start
            result.completed.append(UsDateRange(start=left, end=cursor))
            if not page.cont or oldest <= start:
                cursor = shift(start, -1)
                break
            cursor = shift(oldest, -1)
            previous_oldest = oldest
            next_key = page.next_key
            keys.add(next_key)
        except (KiwoomRestError, KiwoomCapacityOverloaded, TimeoutError, ValueError, KeyError, TypeError) as exc:
            result.messages.append(f"Kiwoom US daily page incomplete: {type(exc).__name__}")
            break
    result.bars = sorted(seen.values(), key=lambda b: b.trading_date)
    result.truncated = cursor >= start
    return result
