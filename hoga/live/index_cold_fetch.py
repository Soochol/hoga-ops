from __future__ import annotations

import asyncio
from calendar import monthrange
from datetime import date
from typing import Awaitable, Callable

from hoga.live.kis_client import IndexCandleFetchResult


def _parse(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def _fmt(d: date) -> str:
    return d.strftime("%Y%m%d")


def _add_months(d: date, months: int) -> date:
    month0 = d.month - 1 + months
    year = d.year + month0 // 12
    month = month0 % 12 + 1
    day = min(d.day, monthrange(year, month)[1])
    return date(year, month, day)


def plan_index_cold_fetch_ranges(from_s: str, to_s: str, period: str) -> list[tuple[str, str]]:
    if period != "D":
        return [(from_s, to_s)]
    start = _parse(from_s)
    end = _parse(to_s)
    ranges: list[tuple[str, str]] = []
    cursor = start
    while cursor <= end:
        next_cursor = _add_months(cursor, 3)
        chunk_end = min(end, next_cursor.replace(day=1) - date.resolution)
        ranges.append((_fmt(cursor), _fmt(chunk_end)))
        cursor = chunk_end + date.resolution
    return ranges


async def fetch_index_daily_candles_windowed(
    from_s: str,
    to_s: str,
    period: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
    *,
    max_concurrency: int = 3,
) -> IndexCandleFetchResult:
    ranges = plan_index_cold_fetch_ranges(from_s, to_s, period)
    if len(ranges) == 1:
        return await fetch_batch(*ranges[0])

    sem = asyncio.Semaphore(max_concurrency)

    async def one(pair: tuple[str, str]) -> IndexCandleFetchResult:
        async with sem:
            return await fetch_batch(*pair)

    results = await asyncio.gather(*(one(pair) for pair in ranges))
    by_t_ms = {}
    violations = []
    for result in results:
        violations.extend(result.violations)
        for candle in result.candles:
            by_t_ms[candle.t_ms] = candle
    return IndexCandleFetchResult(
        candles=sorted(by_t_ms.values(), key=lambda c: c.t_ms),
        violations=violations,
    )
