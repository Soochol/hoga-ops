"""SMA operands, crossings and signed percentage conditions on candle history."""
from __future__ import annotations

import datetime as dt
import math
import operator

from hoga.api import screener_bar_price
from hoga.api.models import BarMaMatch, BarMaValue, ScreenerOccurrence
from hoga.api.screener_bar_policy import RANGE_PARAMS, comparison_period, lookback
from hoga.api.screener_exclusions import condition_key
from hoga.util.timeenc import KST

_COMPARE = {"gt": operator.gt, "gte": operator.ge, "lt": operator.lt, "lte": operator.le, "eq": operator.eq}


class _Operands:
    def __init__(self, bars):
        self.bars, self.means, self.invalid = bars, {}, [0]
        for bar in bars:
            self.invalid.append(self.invalid[-1] + (not bar.valid or not screener_bar_price.valid_prices(bar)))

    def valid(self, first, last):
        return first >= 0 and self.invalid[last + 1] == self.invalid[first]

    def value(self, operand, candidate, *, extra_offset=0):
        offset = operand.offset + extra_offset
        end, period = candidate - offset, getattr(operand, "period", 1)
        first = end - period + 1
        if end < 0 or not self.valid(first, end):
            return None
        if operand.kind == "price":
            value = getattr(self.bars[end], operand.source)
        else:
            key = (operand.source, period)
            if key not in self.means:
                values = [getattr(bar, operand.source) if self.valid(i, i) else 0.0
                          for i, bar in enumerate(self.bars)]
                total, means = 0.0, []
                for i, number in enumerate(values):
                    total += number
                    if i >= period:
                        total -= values[i - period]
                    means.append(total / period)
                self.means[key] = means
            value = self.means[key][end]
        if not math.isfinite(value) or value <= 0:
            return None
        return BarMaValue(kind=operand.kind, offset=offset, source=operand.source,
            period=period if operand.kind == "sma" else None, value=value,
            bar_start_ms=self.bars[end].start_ms, window_start_ms=self.bars[first].start_ms,
            is_open=self.bars[end].is_open)


def _percent_matches(p, value):
    if p.op == "between":
        return p.lo <= value <= p.hi
    return value >= p.pct if p.op == "gte" else value <= p.pct


def _match(leaf, values, i, fetched_at_ms):
    p, kind = leaf.params, leaf.type.removeprefix("ma_").removesuffix("_period")
    if kind == "slope":
        left, right = values.value(p.average, i), values.value(p.average, i, extra_offset=p.lag)
    else:
        left, right = values.value(p.left, i), values.value(p.right, i)
    if left is None or right is None:
        return None, False
    evidence = {}
    if kind == "compare":
        passed = _COMPARE[p.relation](left.value, right.value)
        evidence["relation"] = p.relation
    elif kind == "cross":
        previous_left, previous_right = values.value(p.left, i - 1), values.value(p.right, i - 1)
        if previous_left is None or previous_right is None:
            return None, False
        passed = (previous_left.value <= previous_right.value and left.value > right.value
                  if p.direction == "up" else
                  previous_left.value >= previous_right.value and left.value < right.value)
        evidence.update(direction=p.direction, previous_left=previous_left, previous_right=previous_right)
    else:
        percent = (left.value - right.value) / right.value * 100
        if not math.isfinite(percent):
            return None, False
        passed = _percent_matches(p, percent)
        evidence["value_pct"] = percent
    return (BarMaMatch(kind=kind, timeframe=p.timeframe, left=left, right=right,
        is_open=values.bars[i].is_open, fetched_at_ms=fetched_at_ms, **evidence) if passed else None), True


def records(leaf, bars, *, fetched_at_ms):
    p = leaf.params
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    historical, count = isinstance(p, RANGE_PARAMS), lookback(leaf)
    indices = ([i for i, bar in enumerate(bars) if
        p.start_date <= dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat() <= p.end_date]
        if historical else range(max(0, len(bars) - count), len(bars)))
    complete = bool(indices) and (historical or len(indices) == count)
    values, events, key = _Operands(bars), [], condition_key(leaf)
    period = comparison_period(leaf)
    for i in indices:
        if not values.valid(i - period + 1, i):
            complete = False
            continue
        match, valid = _match(leaf, values, i, fetched_at_ms)
        complete = complete and valid
        if match is not None:
            bar = bars[i]
            events.append(ScreenerOccurrence(condition_id=leaf.id, condition_key=key,
                date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(),
                bar_start_ms=bar.start_ms, bar_ma_match=match))
    return events, complete
