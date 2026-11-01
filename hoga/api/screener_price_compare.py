"""Compare two OHLC operands relative to each candidate candle."""
from __future__ import annotations

import datetime as dt
import operator

from hoga.api import screener_bar_price
from hoga.api.models import BarPriceCompareMatch, BarPriceCompareValue, ScreenerOccurrence
from hoga.api.screener_bar_policy import RANGE_PARAMS, comparison_period, lookback
from hoga.api.screener_exclusions import condition_key
from hoga.util.timeenc import KST

_RELATIONS = {"gt": operator.gt, "gte": operator.ge, "lt": operator.lt, "lte": operator.le, "eq": operator.eq}


def _value(operand, bar):
    return BarPriceCompareValue(offset=operand.offset, source=operand.source,
        value=getattr(bar, operand.source), bar_start_ms=bar.start_ms, is_open=bar.is_open)


def records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    historical = isinstance(p, RANGE_PARAMS)
    count, period = lookback(leaf), comparison_period(leaf)
    indices = ([i for i, bar in enumerate(bars) if
        p.start_date <= dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat() <= p.end_date]
        if historical else range(max(0, len(bars) - count), len(bars)))
    complete = bool(indices) and (historical or len(indices) == count)
    # Missing/invalid candles must never shift an operand to an older candle.
    invalid = [0]
    for bar in bars:
        invalid.append(invalid[-1] + (not bar.valid or not screener_bar_price.valid_prices(bar)))
    key, events = condition_key(leaf), []
    for i in indices:
        first = i - period + 1
        if first < 0 or invalid[i + 1] != invalid[first]:
            complete = False
            continue
        left, right = _value(p.left, bars[i - p.left.offset]), _value(p.right, bars[i - p.right.offset])
        if not _RELATIONS[p.relation](left.value, right.value):
            continue
        bar = bars[i]
        events.append(ScreenerOccurrence(condition_id=leaf.id, condition_key=key,
            date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(), bar_start_ms=bar.start_ms,
            bar_price_compare_match=BarPriceCompareMatch(timeframe=p.timeframe, relation=p.relation,
                left=left, right=right, is_open=bar.is_open, fetched_at_ms=fetched_at_ms)))
    return events, complete
