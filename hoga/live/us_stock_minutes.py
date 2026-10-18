"""Kiwoom native US stock minute bars, bounded recent windows in memory only."""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from pydantic import BaseModel, Field

from hoga.live import kiwoom_access
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_us_daily_candles import EXCHANGE_CODES
from hoga.live.us_daily_candles import NY, UsDailyBar, UsExchange, parse_bar, parse_date
from hoga.live.us_index_minutes import MINUTE_TIMEFRAMES, UsMinuteMetadata

MAX_BARS = 800
MAX_PAGES = 8
MAX_ENTRIES = 64
MAX_PAGE_ROWS = 2000
MAX_EXTENDED_HOUR = 48


class UsStockMinuteMetadata(UsMinuteMetadata):
    source: str = "kiwoom"
    history_scope: str = "bounded_recent_window"
    session_scope: str = "vendor_extended_unverified"
    price_basis: str = "raw"
    currency: str = "USD"
    bar_limit: int = MAX_BARS
    pages_fetched: int = 0
    more_available: bool = False


class UsStockMinuteResponse(BaseModel):
    instrument_key: str
    exchange: UsExchange
    symbol: str
    from_: str = Field(alias="from")
    to: str
    timeframe: str
    candles: list[UsDailyBar] = Field(default_factory=list)
    minute_metadata: UsStockMinuteMetadata


def parse_stock_minute(row: dict) -> UsDailyBar:
    bar = parse_bar(row, fields=("bus_dt", "open_pric", "high_pric", "low_pric", "cur_prc", "trde_qty"))
    stamp = str(row["cntr_tm"])
    if len(stamp) != len("YYYYMMDDHHMMSS") or not stamp.isdigit() or stamp[-2:] != "00":
        raise ValueError("invalid Kiwoom US minute time")
    # Kiwoom represents next-day overnight bars as 24:xx .. 27:xx (observed
    # 26:10). Normalize a single day carry before applying NY's DST offset.
    hour = int(stamp[8:10])
    if hour >= MAX_EXTENDED_HOUR:
        raise ValueError("unsupported Kiwoom extended hour")
    parse_date(stamp[:8])
    wall = datetime.strptime(stamp[:8] + f"{hour % 24:02}" + stamp[10:], "%Y%m%d%H%M%S")
    wall += timedelta(days=hour // 24)
    local = wall.replace(tzinfo=NY)
    epoch_ms = int(local.timestamp() * 1000)
    if datetime.fromtimestamp(epoch_ms / 1000, NY).strftime("%Y%m%d%H%M%S") != wall.strftime("%Y%m%d%H%M%S"):
        raise ValueError("nonexistent NY local time")
    return bar.model_copy(update={"t_ms": epoch_ms})


@dataclass
class StockMinuteWindow:
    bars: list[UsDailyBar] = field(default_factory=list)
    pages: int = 0
    more: bool = False
    failed: bool = False
    messages: list[str] = field(default_factory=list)


async def fetch_stock_minutes(client, scheduler, exchange, symbol, timeframe, anchor,
                              *, max_pages=MAX_PAGES, budget_seconds=12) -> StockMinuteWindow:
    body = {"stex_tp": EXCHANGE_CODES[exchange], "stk_cd": symbol, "strt_dt": anchor,
            "tic_scope": timeframe[:-1], "upd_stkpc_tp": "0", "exrt_appl_tp": "0"}
    result = StockMinuteWindow()
    seen: dict[int, UsDailyBar] = {}
    cursor, cursors, previous_oldest = "", set(), None
    deadline = time.monotonic() + budget_seconds
    for _ in range(max_pages):
        try:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("US minute request budget")

            async def call(c, token=cursor):
                return await c.call("usa06011", body, cont=bool(token), next_key=token)

            page = await asyncio.wait_for(kiwoom_access.run_with_capacity(
                scheduler, key=("us-stock-minute", exchange, symbol, timeframe, anchor, "raw-USD", cursor),
                api_id="usa06011", priority="user_visible", fetch_fn=call, client=client,
            ), remaining)
            if page.raw.get("return_code") != 0 or not isinstance(page.raw.get("result_list"), list):
                raise ValueError("invalid Kiwoom US minute envelope")
            if len(page.rows) > MAX_PAGE_ROWS:
                raise ValueError("oversized Kiwoom US minute page")
            bars = [parse_stock_minute(row) for row in page.rows]
            if any(b.trading_date > anchor for b in bars):
                raise ValueError("out-of-range Kiwoom US business date")
            oldest = min((b.t_ms for b in bars), default=None)
            if previous_oldest is not None and oldest is not None and oldest >= previous_oldest:
                raise ValueError("Kiwoom US minute cursor stalled")
            if page.cont and (not bars or not page.next_key or page.next_key in cursors):
                raise ValueError("invalid Kiwoom US minute continuation")
            for bar in bars:
                if bar.t_ms in seen and seen[bar.t_ms] != bar:
                    raise ValueError("conflicting Kiwoom US minute timestamps")
                seen[bar.t_ms] = bar
            result.pages += 1
            result.more = page.cont
            if not page.cont or len(seen) >= MAX_BARS:
                break
            cursor, previous_oldest = page.next_key, oldest
            cursors.add(cursor)
        except (KiwoomRestError, KiwoomCapacityOverloaded, TimeoutError, ValueError, KeyError, TypeError) as exc:
            result.failed = True
            result.messages.append(f"US minute window incomplete: {type(exc).__name__}")
            break
    result.bars = sorted(seen.values(), key=lambda b: b.t_ms)[-MAX_BARS:]
    return result


@dataclass
class _Entry:
    bars: list[UsDailyBar] = field(default_factory=list)
    meta: UsStockMinuteMetadata = field(default_factory=UsStockMinuteMetadata)
    expiry: float = 0


class UsStockMinuteService:
    def __init__(self, *, clock=time.monotonic, wall_clock=time.time, calendar_now=lambda: datetime.now(NY)):
        self.clock, self.wall_clock, self.calendar_now = clock, wall_clock, calendar_now
        self.entries: OrderedDict[tuple[str, str, str], _Entry] = OrderedDict()
        self.pending: dict[tuple[str, str, str], asyncio.Task] = {}

    async def get(self, exchange, symbol, timeframe, *, client=None, scheduler=None, bypass=False):
        if exchange not in EXCHANGE_CODES or timeframe not in MINUTE_TIMEFRAMES:
            raise ValueError("unsupported US stock minute exchange/period")
        key = (exchange, symbol, timeframe)
        if key not in self.entries:
            if len(self.entries) >= MAX_ENTRIES:
                victim = next((k for k in self.entries if k not in self.pending), None)
                if victim is None:
                    return [], UsStockMinuteMetadata(refresh_status="error", messages=["US minute cache busy"])
                del self.entries[victim]
            self.entries[key] = _Entry()
        entry = self.entries[key]
        self.entries.move_to_end(key)
        if client is not None and not bypass:
            if key in self.pending:
                await asyncio.shield(self.pending[key])
            elif self.clock() >= entry.expiry:
                task = asyncio.create_task(self._refresh(key, entry, client, scheduler))
                self.pending[key] = task
                task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
                await asyncio.shield(task)
        meta = entry.meta
        if bypass or client is None:
            meta = meta.model_copy(update={"refresh_status": "bypass" if bypass else "unconfigured"})
        return entry.bars, meta

    async def _refresh(self, key, entry, client, scheduler):
        try:
            window = await fetch_stock_minutes(client, scheduler, *key, self.calendar_now().strftime("%Y%m%d"))
            if window.failed and entry.meta.last_successful_check_at_ms is not None:
                entry.meta = entry.meta.model_copy(update={"refresh_status": "stale", "messages": window.messages})
            else:
                entry.bars = window.bars
                entry.meta = UsStockMinuteMetadata(
                    pages_fetched=window.pages, more_available=window.more,
                    available_from_ms=window.bars[0].t_ms if window.bars else None,
                    available_to_ms=window.bars[-1].t_ms if window.bars else None,
                    last_successful_check_at_ms=int(self.wall_clock() * 1000) if not window.failed else None,
                    refresh_status=("partial" if window.failed and window.bars else
                                    "error" if window.failed else "normal"),
                    messages=window.messages,
                )
            entry.expiry = self.clock() + (30 if window.failed else 60)
        finally:
            self.pending.pop(key, None)

    async def aclose(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()
