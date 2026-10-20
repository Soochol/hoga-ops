"""Outward Bollinger crossings using each candle's own trailing population SD."""
from __future__ import annotations

import datetime as dt
import math

from hoga.api import screener_bar_price, screener_exclusions
from hoga.api.models import BarPriceMatch, ScreenerOccurrence
from hoga.api.screener_bar_policy import lookback
from hoga.util.timeenc import KST


def _bands(values, valid, *, period, multiplier, band_side):
    origin = total = squares = invalid = 0
    for i in range(len(values)):
        left = max(0, i - period + 1)
        # Match the chart: centered moments avoid cancellation for expensive
        # stocks; periodic rebasing bounds drift without an O(n * period) scan.
        if i % period == 0:
            origin = values[i]
            total = squares = invalid = 0
            for j in range(left, i + 1):
                if not valid[j]:
                    invalid += 1
                else:
                    delta = values[j] - origin
                    total += delta
                    squares += delta * delta
        else:
            if i >= period:
                if not valid[i - period]:
                    invalid -= 1
                else:
                    delta = values[i - period] - origin
                    total -= delta
                    squares -= delta * delta
            if not valid[i]:
                invalid += 1
            else:
                delta = values[i] - origin
                total += delta
                squares += delta * delta
        band = None
        if i >= period - 1 and not invalid:
            mean = total / period
            width = multiplier * math.sqrt(max(0, squares / period - mean * mean))
            band = origin + mean + (width if band_side == "upper" else -width)
        yield band


def records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    count, period = lookback(leaf), p.period
    start = max(0, len(bars) - count)
    complete = len(bars) >= count + period
    valid = [bar.valid and screener_bar_price.valid_prices(bar) for bar in bars]
    values = [getattr(bar, p.band_source) if valid[i] else 0.0 for i, bar in enumerate(bars)]
    events = []
    key = screener_exclusions.condition_key(leaf)
    bands = list(_bands(values, valid, period=period, multiplier=p.multiplier, band_side=p.band))
    for i in range(start, len(bars)):
        bar = bars[i]
        previous = bands[i - 1] if i else None
        reference = bands[i]
        if previous is None or reference is None:
            complete = False
            continue
        value = getattr(bar, p.source)
        old_value = getattr(bars[i - 1], p.source)
        crossed = (old_value <= previous and value > reference if p.band == "upper"
                   else old_value >= previous and value < reference)
        if crossed:
            events.append(ScreenerOccurrence(condition_id=leaf.id, condition_key=key,
                date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(),
                bar_start_ms=bar.start_ms,
                bar_price_match=BarPriceMatch(timeframe=p.timeframe, source=p.source,
                    value=value, reference=reference, window_start_ms=bars[i - period + 1].start_ms,
                    is_open=bar.is_open, fetched_at_ms=fetched_at_ms)))
    return events, complete
