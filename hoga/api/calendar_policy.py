"""Calendar policy adapters for scheduler and Live Capture callers."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from hoga.api import calendar

TradingDaysInRange = Callable[[str, str], list[str]]
TradingSessionVerdict = Callable[[str], bool | None]


def live_session_allowed_by_calendar(
    verdict_for_day: TradingSessionVerdict,
    today_yyyymmdd: str,
) -> bool:
    """Live Capture policy: missing calendar data is lenient.

    A False verdict closes the session; None means KIS chk-holiday is unavailable,
    so the clock gate remains authoritative rather than silently stopping capture.
    """
    return verdict_for_day(today_yyyymmdd) is not False


def live_session_allowed_today(today_yyyymmdd: str) -> bool:
    return live_session_allowed_by_calendar(calendar.is_trading_session_today, today_yyyymmdd)


async def daily_run_allowed_by_calendar(
    trading_days: TradingDaysInRange,
    today_yyyymmdd: str,
) -> bool:
    """Daily Scheduler policy: missing calendar data fails closed."""
    try:
        days = await asyncio.to_thread(trading_days, today_yyyymmdd, today_yyyymmdd)
    except Exception:  # noqa: BLE001
        return False
    return today_yyyymmdd in days


async def daily_run_allowed_today(today_yyyymmdd: str) -> bool:
    return await daily_run_allowed_by_calendar(calendar.trading_days_in_range, today_yyyymmdd)


async def trading_days_for_enqueue(
    trading_days: TradingDaysInRange,
    start_yyyymmdd: str,
    end_yyyymmdd: str,
) -> list[str]:
    """Enqueue/catch-up policy: fail fast when the calendar accessor fails."""
    return await asyncio.to_thread(trading_days, start_yyyymmdd, end_yyyymmdd)


async def trading_days_for_enqueue_range(start_yyyymmdd: str, end_yyyymmdd: str) -> list[str]:
    return await trading_days_for_enqueue(calendar.trading_days_in_range, start_yyyymmdd, end_yyyymmdd)
