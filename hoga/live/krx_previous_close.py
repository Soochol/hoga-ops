"""Exact previous-session KRX raw close for day-price tooltips."""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from datetime import date, datetime, timedelta
from pathlib import Path

from pydantic import BaseModel

from hoga.api.calendar import TradingDayUnavailableError, trading_days_in_range
from hoga.live.candle_fetch_result import DailyCandleFetchResult
from hoga.util.atomic_write import atomic_write_json
from hoga.util.timeenc import KST

_CALENDAR_LOOKBACK_DAYS = 60
_MISS_TTL_MS = 60_000


class KrxPreviousCloseResponse(BaseModel):
    code: str
    as_of: str
    session_date: str | None = None
    date: str | None = None
    price: int | None = None
    fetched_at_ms: int | None = None


class KrxPreviousCloseStore:
    def __init__(self, data_dir: Path | None):
        self.data_dir = data_dir
        self.lock = asyncio.Lock()
        self.recent: dict[tuple[str, str], KrxPreviousCloseResponse] = {}

    async def get(
        self, code: str, as_of: date, now: datetime,
        fetch: Callable[[str], Awaitable[DailyCandleFetchResult]],
    ) -> KrxPreviousCloseResponse:
        as_of_s = as_of.strftime("%Y%m%d")
        empty = KrxPreviousCloseResponse(code=code, as_of=as_of_s)
        try:
            days = trading_days_in_range(
                (as_of - timedelta(days=_CALENDAR_LOOKBACK_DAYS)).strftime("%Y%m%d"), as_of_s,
            )
        except TradingDayUnavailableError:
            return empty
        if len(days) < 2:  # noqa: PLR2004 — current session plus its predecessor
            return empty
        # On weekends/holidays the displayed daily OHLC belongs to the last session.
        session_date, previous_date = days[-1], days[-2]
        empty = KrxPreviousCloseResponse(
            code=code, as_of=as_of_s, session_date=session_date, date=previous_date,
        )
        key = (code, previous_date)
        path = self.data_dir / "krx-previous-close" / previous_date / f"{code}.json" if self.data_dir else None
        now_ms = int(now.timestamp() * 1000)
        async with self.lock:
            cached = self.recent.get(key)
            if cached is None and path is not None:
                try:
                    saved = KrxPreviousCloseResponse.model_validate_json(path.read_text())
                    if (
                        saved.code == code and saved.date == previous_date
                        and saved.price is not None and saved.price > 0
                    ):
                        cached = saved
                except (OSError, ValueError):
                    pass
            if cached is not None and (
                cached.price is not None
                or (cached.fetched_at_ms is not None and now_ms - cached.fetched_at_ms < _MISS_TTL_MS)
            ):
                self.recent[key] = cached
                return cached.model_copy(update={"as_of": as_of_s, "session_date": session_date})
            result = await fetch(previous_date)
            # Never substitute an older row, an adjusted quote baseline, or today's close.
            candle = next((c for c in result.candles
                           if datetime.fromtimestamp(c.t_ms / 1000, KST).strftime("%Y%m%d") == previous_date), None)
            price = int(candle.close) if candle is not None and candle.close > 0 else None
            response = empty.model_copy(update={"price": price, "fetched_at_ms": now_ms})
            self.recent[key] = response
            if path is not None and price is not None:
                atomic_write_json(path, response.model_dump())
            return response
