"""US weekly/monthly OHLC from verified daily ranges, using trading dates.

The first source trading date anchors each bucket, as in the domestic chart.
Never publish a bucket whose prefix or interior has not actually been fetched.
"""

from __future__ import annotations

import calendar
from datetime import timedelta

from hoga.live.us_daily_candles import UsDailyBar, UsDateRange, missing_ranges, parse_date


def calendar_bounds(day: str, timeframe: str) -> tuple[str, str]:
    value = parse_date(day)
    if timeframe == "W":
        first = value - timedelta(days=value.weekday())
        last = first + timedelta(days=6)
    elif timeframe == "M":
        first = value.replace(day=1)
        last = value.replace(day=calendar.monthrange(value.year, value.month)[1])
    elif timeframe == "D":
        first = last = value
    else:
        raise ValueError("US calendar candles support D/W/M only")
    return first.strftime("%Y%m%d"), last.strftime("%Y%m%d")


def aggregate_us_calendar(
    bars: list[UsDailyBar], timeframe: str, through: str, verified: list[UsDateRange]
) -> list[UsDailyBar]:
    buckets: dict[str, list[UsDailyBar]] = {}
    for bar in sorted(bars, key=lambda b: b.trading_date):
        if bar.trading_date <= through:
            first, _ = calendar_bounds(bar.trading_date, timeframe)
            buckets.setdefault(first, []).append(bar)
    result = []
    for first, rows in buckets.items():
        _, last = calendar_bounds(first, timeframe)
        if missing_ranges(first, min(last, through), verified):
            continue
        result.append(
            rows[0].model_copy(
                update={
                    "high": max(b.high for b in rows),
                    "low": min(b.low for b in rows),
                    "close": rows[-1].close,
                    "volume": sum(b.volume for b in rows),
                }
            )
        )
    return result
