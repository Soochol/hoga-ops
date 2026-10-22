"""Index title-bar readout, independent of chart period and historical cursor.

KR quotes reuse the market bar's TTL cache. US quotes reuse the bounded minute
snapshot and verified daily cache; daily display anchors are never quote times.
"""
from __future__ import annotations

import asyncio
import math
from datetime import datetime, timedelta
from typing import Literal

from pydantic import BaseModel

from hoga.api import calendar
from hoga.live.us_daily_candles import NY, shift
from hoga.util.timeenc import KST

IndexQuoteSession = Literal["open", "closed", "unknown"]
IndexQuoteRefresh = Literal["normal", "stale", "error", "unconfigured", "bypass", "partial"]
INDEX_QUOTE_RETRY_COOLDOWN_S = 2


class IndexHeaderQuoteResponse(BaseModel):
    index_id: str
    value: float | None = None
    change: float | None = None
    change_rate: float | None = None
    previous_close: float | None = None
    trading_date: str | None = None
    observed_at_ms: int | None = None
    checked_at_ms: int | None = None
    market_timezone: str = "Asia/Seoul"
    session_status: IndexQuoteSession = "unknown"
    refresh_status: IndexQuoteRefresh = "normal"
    source: str = "kiwoom"
    delay_unverified: bool = False
    refresh_interval_ms: int = 30_000


def domestic_session(now: datetime) -> tuple[str | None, IndexQuoteSession]:
    """No weekday approximation outside the committed calendar's coverage."""
    local = now.astimezone(KST)
    today = local.strftime("%Y%m%d")
    try:
        days = calendar.trading_days_in_range((local - timedelta(days=60)).strftime("%Y%m%d"), today)
    except calendar.TradingDayUnavailableError:
        return None, "unknown"
    if not days:
        return None, "unknown"
    clock = (local.hour, local.minute)
    if days[-1] == today and clock < (9, 0):
        return (days[-2] if len(days) > 1 else None), "closed"
    return days[-1], "open" if days[-1] == today and (9, 0) <= clock < (15, 30) else "closed"


def domestic_header_quote(index_id: str, quote, checked_at_ms: int | None, status: IndexQuoteRefresh):
    response = IndexHeaderQuoteResponse(index_id=index_id, checked_at_ms=checked_at_ms, refresh_status=status)
    if quote is None:
        return response
    if not all(math.isfinite(v) for v in (quote.value, quote.change, quote.change_rate)) or quote.value <= 0:
        return response.model_copy(update={"refresh_status": "error"})
    # Use the last SUCCESSFUL lookup's date, never relabel cached Friday data on Monday.
    checked = datetime.fromtimestamp(checked_at_ms / 1000, KST) if checked_at_ms else None
    day, checked_phase = domestic_session(checked) if checked else (None, "unknown")
    _, phase = domestic_session(datetime.now(KST))
    base = round(quote.value - quote.change, 2)
    return response.model_copy(update={
        "value": quote.value, "change": quote.change, "change_rate": quote.change_rate,
        "previous_close": base if base > 0 else None, "trading_date": day,
        "session_status": phase,
        # ka20001 supplies only HHMMSS (or 888888), not an actual date. Do not
        # manufacture a timestamp for closed/sentinel rows from today's anchor.
        "observed_at_ms": quote.t_ms if checked_phase == "open" and checked
        and quote.t_ms <= checked_at_ms and datetime.fromtimestamp(quote.t_ms / 1000, KST).date() == checked.date()
        else None,
    })


async def us_header_quote(index, markets, now: datetime | None = None) -> IndexHeaderQuoteResponse:
    local = (now or datetime.now(NY)).astimezone(NY)
    end = local.strftime("%Y%m%d")
    (minutes, minute_meta), (daily, daily_meta) = await asyncio.gather(
        markets.index_minutes(index, "1m"), markets.index_daily(index, shift(end, -60), end),
    )
    # Completed daily closes win over same-day provisional minute closes.
    last_minute = max(minutes, key=lambda b: b.t_ms, default=None)
    last_daily = max(daily, key=lambda b: b.trading_date, default=None)
    use_daily = last_daily is not None and (last_minute is None or last_daily.trading_date >= last_minute.trading_date)
    latest = last_daily if use_daily else last_minute
    meta = daily_meta if use_daily else minute_meta
    response = IndexHeaderQuoteResponse(
        index_id=index.id, market_timezone=index.market_timezone, source="kis_daily" if use_daily else "kis_minute",
        delay_unverified=True, refresh_status=meta.refresh_status,
        checked_at_ms=meta.last_successful_check_at_ms,
        refresh_interval_ms=minute_meta.refresh_interval_ms,
    )
    if latest is None:
        status = meta.refresh_status if meta.refresh_status != "normal" else "partial"
        return response.model_copy(update={"refresh_status": status})
    previous = max((b for b in daily if b.trading_date < latest.trading_date),
                   key=lambda b: b.trading_date, default=None)
    # A gap may contain a more recent trading day: never silently use an older close.
    baseline_verified = previous is not None and not any(
        gap.start <= shift(latest.trading_date, -1) and gap.end > previous.trading_date
        for gap in daily_meta.missing
    )
    base = previous.close if baseline_verified else None
    change = latest.close - base if base else None
    phase: IndexQuoteSession = "closed" if use_daily else "unknown"
    if not use_daily and latest.trading_date == end and (9, 30) <= (local.hour, local.minute) < (16, 0):
        phase = "open"
    if not use_daily and (latest.trading_date < end or (local.hour, local.minute) >= (16, 0)):
        phase = "closed"
    status = response.refresh_status
    if minute_meta.refresh_status in {"error", "stale"} and not (use_daily and latest.trading_date == end):
        status = "stale"
    if not baseline_verified and status == "normal":
        status = daily_meta.refresh_status if daily_meta.refresh_status != "normal" else "partial"
    return response.model_copy(update={
        "value": latest.close, "change": change, "previous_close": base,
        "change_rate": change / base * 100 if base and change is not None else None,
        "trading_date": latest.trading_date, "observed_at_ms": None if use_daily else latest.t_ms,
        "session_status": phase, "refresh_status": status,
    })
