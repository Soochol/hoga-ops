"""Memory-only US daily history, with independently expiring verified coverage.

Vendor adapters own pagination. A short page is never interpreted as complete
history. Trading dates are canonical; t_ms is a synthetic display anchor only.
"""

from __future__ import annotations

import asyncio
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, Field

from hoga.live.candle_models import daily_anchor_ms

NY = ZoneInfo("America/New_York")
UsExchange = Literal["NASDAQ", "NYSE", "AMEX"]
UsDailyStatus = Literal["normal", "stale", "unconfigured", "error", "bypass", "partial"]


class UsDailyBar(BaseModel):
    trading_date: str
    t_ms: int
    open: float
    high: float
    low: float
    close: float
    volume: int = 0


class UsDateRange(BaseModel):
    start: str
    end: str


class UsDailyMetadata(BaseModel):
    market: str = "US"
    market_timezone: str = "America/New_York"
    source: str
    price_basis: str
    currency: str
    session_scope: str
    # Unknown until a broad older negative interval and first positive day are verified together.
    history_start: str | None = None
    latest_bar_date: str | None = None
    last_successful_check_at_ms: int | None = None
    completed: list[UsDateRange] = Field(default_factory=list)
    missing: list[UsDateRange] = Field(default_factory=list)
    truncated: bool = False
    refresh_status: UsDailyStatus = "normal"
    messages: list[str] = Field(default_factory=list)


class UsStockDailyResponse(BaseModel):
    instrument_key: str
    exchange: UsExchange
    symbol: str
    from_: str = Field(alias="from")
    to: str
    timeframe: str = "D"
    candles: list[UsDailyBar] = Field(default_factory=list)
    daily_metadata: UsDailyMetadata


def parse_date(value: str) -> date:
    if len(value) != len("YYYYMMDD") or not value.isdigit():
        raise ValueError("date must be YYYYMMDD")
    return datetime.strptime(value, "%Y%m%d").date()


def shift(value: str, days: int) -> str:
    return (parse_date(value) + timedelta(days=days)).strftime("%Y%m%d")


def completed_through(*, stock: bool, now: datetime | None = None) -> str:
    local = (now or datetime.now(NY)).astimezone(NY)
    # Index vendor-final guarantee is unavailable: 16:30 ET is our policy.
    # Stock daily session scope is unverified; never publish today's bar as final.
    ready = not stock and (local.hour, local.minute) >= (16, 30)
    return (local.date() - timedelta(days=0 if ready else 1)).strftime("%Y%m%d")


def parse_bar(row: dict, *, fields: tuple[str, str, str, str, str, str]) -> UsDailyBar:
    day_key, open_key, high_key, low_key, close_key, volume_key = fields
    day = str(row[day_key]).strip()
    parse_date(day)
    try:
        values = [Decimal(str(row[k]).strip().replace(",", "")) for k in (open_key, high_key, low_key, close_key)]
        if any(not v.is_finite() or v <= 0 for v in values):
            raise ValueError("nonpositive/nonfinite OHLC")
        op, hi, lo, cl = values
        if not (lo <= min(op, cl) <= max(op, cl) <= hi):
            raise ValueError("inconsistent OHLC")
        volume = Decimal(str(row.get(volume_key, "0")).strip().replace(",", "") or "0")
        if not volume.is_finite() or volume < 0 or volume != volume.to_integral_value():
            raise ValueError("invalid volume")
    except InvalidOperation as exc:
        raise ValueError("invalid numeric field") from exc
    return UsDailyBar(
        trading_date=day,
        t_ms=daily_anchor_ms(day),
        open=float(op),
        high=float(hi),
        low=float(lo),
        close=float(cl),
        volume=int(volume),
    )


@dataclass
class UsFetchResult:
    bars: list[UsDailyBar] = field(default_factory=list)
    completed: list[UsDateRange] = field(default_factory=list)
    truncated: bool = False
    messages: list[str] = field(default_factory=list)


Fetch = Callable[[str, str], Awaitable[UsFetchResult]]


def missing_ranges(start: str, end: str, coverage: list[UsDateRange]) -> list[UsDateRange]:
    cursor = start
    missing: list[UsDateRange] = []
    for span in sorted(coverage, key=lambda s: s.start):
        if span.end < cursor or span.start > end:
            continue
        if cursor < span.start:
            missing.append(UsDateRange(start=cursor, end=shift(span.start, -1)))
        if span.end >= end:
            return missing
        cursor = max(cursor, shift(span.end, 1))
    if cursor <= end:
        missing.append(UsDateRange(start=cursor, end=end))
    return missing


def merge_date_ranges(ranges: list[UsDateRange]) -> list[UsDateRange]:
    merged: list[UsDateRange] = []
    for span in sorted(ranges, key=lambda s: s.start):
        if merged and span.start <= shift(merged[-1].end, 1):
            merged[-1] = UsDateRange(start=merged[-1].start, end=max(merged[-1].end, span.end))
        else:
            merged.append(span)
    return merged


@dataclass
class _Entry:
    rows: dict[str, UsDailyBar] = field(default_factory=dict)
    coverage: list[tuple[UsDateRange, float]] = field(default_factory=list)
    # Last-good completeness survives freshness expiry, just like the stored bars.
    verified: list[UsDateRange] = field(default_factory=list)
    successful_at_ms: int | None = None
    retry_at: float = 0
    failures: int = 0
    messages: list[str] = field(default_factory=list)


class UsDailyService:
    def __init__(
        self,
        *,
        max_instruments: int = 128,
        clock: Callable[[], float] = time.monotonic,
        calendar_now: Callable[[], datetime] | None = None,
    ) -> None:
        self.entries: OrderedDict[str, _Entry] = OrderedDict()
        self.pending: dict[str, asyncio.Task] = {}
        self.max_instruments = max_instruments
        self.clock = clock
        self.calendar_now = calendar_now or (lambda: datetime.now(NY))

    def verified_coverage(self, key: str) -> list[UsDateRange]:
        entry = self.entries.get(key)
        return list(entry.verified) if entry else []

    async def aclose(self) -> None:
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()

    async def get(
        self,
        key: str,
        start: str,
        end: str,
        *,
        source: str,
        price_basis: str,
        stock: bool,
        fetch: Fetch | None,
        bypass: bool = False,
    ) -> tuple[list[UsDailyBar], UsDailyMetadata]:
        parse_date(start)
        parse_date(end)
        end = min(end, completed_through(stock=stock, now=self.calendar_now()))
        entry = self.entries.setdefault(key, _Entry())
        self.entries.move_to_end(key)
        while len(self.entries) > self.max_instruments:
            victim = next((k for k in self.entries if k not in self.pending and k != key), None)
            if victim is None:
                break
            del self.entries[victim]
        if key in self.pending:
            await asyncio.shield(self.pending[key])
        now = self.clock()
        entry.coverage = [(s, expiry) for s, expiry in entry.coverage if expiry > now]
        missing = missing_ranges(start, end, [s for s, _ in entry.coverage]) if start <= end else []
        if missing and fetch and not bypass and now >= entry.retry_at:
            task = asyncio.create_task(self._load(key, entry, missing, fetch))
            self.pending[key] = task
            # Own the task even if every HTTP waiter disconnects.
            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            await asyncio.shield(task)
        complete = [
            UsDateRange(start=max(start, s.start), end=min(end, s.end))
            for s, expiry in entry.coverage
            if expiry > self.clock() and s.start <= end and s.end >= start
        ]
        missing = missing_ranges(start, end, complete) if start <= end else []
        rows = sorted((b for d, b in entry.rows.items() if start <= d <= end), key=lambda b: b.trading_date)
        status: UsDailyStatus = "normal"
        if bypass:
            status = "bypass"
        elif fetch is None:
            status = "unconfigured"
        elif entry.failures:
            status = "stale" if rows else "error"
        elif missing:
            status = "partial"
        return rows, UsDailyMetadata(
            source=source,
            price_basis=price_basis,
            currency="USD" if stock else "index_points",
            session_scope="vendor_daily_unverified" if stock else "cash_index",
            latest_bar_date=rows[-1].trading_date if rows else None,
            last_successful_check_at_ms=entry.successful_at_ms,
            completed=complete,
            missing=missing,
            truncated=bool(missing),
            refresh_status=status,
            messages=entry.messages,
        )

    async def _load(self, key: str, entry: _Entry, missing: list[UsDateRange], fetch: Fetch) -> None:
        try:
            # One bounded vendor walk per HTTP request. Other holes remain explicit.
            span = missing[-1]
            result = await fetch(span.start, span.end)
            for bar in result.bars:
                if span.start <= bar.trading_date <= span.end:
                    entry.rows[bar.trading_date] = bar
            now = self.clock()
            tail = shift(self.calendar_now().strftime("%Y%m%d"), -14)
            for covered in result.completed:
                if not (span.start <= covered.start <= covered.end <= span.end):
                    raise ValueError("adapter coverage outside requested interval")
                entry.verified = merge_date_ranges([*entry.verified, covered])
                # All historical coverage has a finite life (including negative lookups).
                if covered.start < tail:
                    older = UsDateRange(start=covered.start, end=min(covered.end, shift(tail, -1)))
                    entry.coverage.append((older, now + 86400))
                if covered.end >= tail:
                    entry.coverage.append((UsDateRange(start=max(covered.start, tail), end=covered.end), now + 300))
            entry.messages = result.messages
            if result.messages:
                entry.failures += 1
                entry.retry_at = now + min(300, 30 * 2 ** min(entry.failures - 1, 4))
            else:
                entry.failures = 0
                entry.retry_at = 0
                if result.completed:
                    entry.successful_at_ms = int(time.time() * 1000)
        finally:
            self.pending.pop(key, None)
            while len(self.entries) > self.max_instruments:
                victim = next((k for k in self.entries if k not in self.pending), None)
                if victim is None:
                    break
                del self.entries[victim]
