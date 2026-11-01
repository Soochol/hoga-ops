"""Exact share-quantity predicates; average references exclude the target candle."""
from __future__ import annotations

import datetime as dt
import math
import operator
from fractions import Fraction

from hoga.api.models import BarVolumeConditionMatch, BarVolumeValue, ScreenerOccurrence
from hoga.api.screener_bar_policy import RANGE_PARAMS, comparison_period, lookback
from hoga.api.screener_exclusions import condition_key
from hoga.util.timeenc import KST

_COMPARE = {"gt": operator.gt, "gte": operator.ge, "lt": operator.lt, "lte": operator.le, "eq": operator.eq}


def evaluate(leaf, bars, *, fetched_at_ms, basis=None):
    p, kind = leaf.params, leaf.type.removeprefix("volume_").removesuffix("_period")
    bars = [bar for bar in bars if p.include_open_bar or not bar.is_open]
    historical, count = isinstance(p, RANGE_PARAMS), lookback(leaf)
    indices = ([i for i, bar in enumerate(bars) if p.start_date <=
        dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat() <= p.end_date]
        if historical else range(max(0, len(bars) - count), len(bars)))
    complete, reason = bool(indices) and (historical or len(indices) == count), None
    invalid, totals = [0], [Fraction()]
    for bar in bars:
        valid = (bar.valid and not isinstance(bar.volume, bool)
                 and isinstance(bar.volume, (int, Fraction)) and bar.volume >= 0)
        invalid.append(invalid[-1] + (not valid))
        totals.append(totals[-1] + (bar.volume if valid else 0))

    def value(i, offset):
        bar = bars[i - offset]
        return BarVolumeValue(offset=offset, value=str(bar.volume), bar_start_ms=bar.start_ms, is_open=bar.is_open)

    events, key, required = [], condition_key(leaf), comparison_period(leaf)
    for i in indices:
        first = i - required + 1
        if first < 0 or invalid[i + 1] != invalid[first]:
            complete = False
            continue
        left_offset = p.left_offset if kind == "compare" else p.offset
        left = value(i, left_offset)
        quantity, extra = Fraction(left.value), {}
        if kind == "range":
            passed = (p.min_volume is None or quantity >= p.min_volume) and (
                p.max_volume is None or quantity <= p.max_volume)
        elif kind == "compare":
            right = value(i, p.right_offset)
            passed = _COMPARE[p.relation](quantity, Fraction(right.value))
            extra.update(right=right, relation=p.relation)
        else:
            end = i - p.offset
            average = (totals[end] - totals[end - p.period]) / p.period
            if average == 0:
                complete, reason = False, "zero_average_volume"
                continue
            ratio = quantity / average * 100
            try:
                ratio_pct = float(ratio)
            except OverflowError:
                ratio_pct = math.inf
            if not math.isfinite(ratio_pct):
                complete, reason = False, "invalid_volume_ratio"
                continue
            passed = (Fraction(str(p.lo)) <= ratio <= Fraction(str(p.hi)) if p.op == "between" else
                      ratio >= Fraction(str(p.pct)) if p.op == "gte" else ratio <= Fraction(str(p.pct)))
            extra.update(average=str(average), ratio_pct=ratio_pct, period=p.period,
                         window_start_ms=bars[end - p.period].start_ms, window_end_ms=bars[end - 1].start_ms)
        if passed:
            bar = bars[i]
            match = BarVolumeConditionMatch(kind=kind, timeframe=p.timeframe,
                basis="raw" if p.timeframe.endswith("m") else basis, left=left,
                is_open=bar.is_open, fetched_at_ms=fetched_at_ms, **extra)
            events.append(ScreenerOccurrence(condition_id=leaf.id, condition_key=key,
                date=dt.datetime.fromtimestamp(bar.start_ms / 1000, KST).date().isoformat(),
                bar_start_ms=bar.start_ms, bar_volume_condition_match=match))
    return events, complete, reason


def records(leaf, bars, *, fetched_at_ms):
    events, complete, _ = evaluate(leaf, bars, fetched_at_ms=fetched_at_ms)
    return events, complete
