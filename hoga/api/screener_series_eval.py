"""Calendar predicates over separate bases; share comparisons never round volume."""

from __future__ import annotations

import datetime as dt
from fractions import Fraction

from hoga.api import screener_bar_volume as bars, screener_history_coverage as history, screener_series_values as values
from hoga.api.models import (
    BarVolumeCoverageItem,
    HistoryDateRangeParams,
    ScreenerAmountEvidence,
    ScreenerOccurrence,
    ScreenerVolumeEvidence,
)
from hoga.api.screener_bar_policy import TRADE_VALUE_TYPES, VOLUME_TYPES, comparison_period, lookback
from hoga.api.screener_exclusions import condition_key

POLICY = "separate_bases_v2"


def _windows(leaf, days, clock):
    p = leaf.params
    if isinstance(p, HistoryDateRangeParams) and not hasattr(p, "timeframe"):
        plan = history.plan_windows(leaf, days)
        return [
            ([([day], False, True) for day in plan.dates[left : i + 1]], plan.calendar_complete)
            for i, left in enumerate(plan.left_indices)
            if plan.eligible[i]
        ]
    if leaf.type == "price_range":
        return [([window], valid) for window in bars._calendar_windows(days, "D", clock)[-1:] for valid in [window[2]]]
    windows = bars._required_windows(leaf, days, clock)
    period = comparison_period(leaf)
    if isinstance(p, HistoryDateRangeParams):
        candidates = [i for i, window in enumerate(windows) if p.start_date <= window[0][0].isoformat() <= p.end_date]
    else:
        usable = [i for i, window in enumerate(windows) if p.include_open_bar or not window[1]]
        candidates = usable[-lookback(leaf) :]
    calendar_ok = bars._calendar_complete(leaf, windows, days, clock)
    return [(windows[max(0, i - period + 1) : i + 1], calendar_ok and i + 1 >= period) for i in candidates]


def _event(leaf, day, **evidence):
    return ScreenerOccurrence(
        condition_id=leaf.id,
        condition_key=condition_key(leaf, calculation_policy=POLICY),
        date=day.isoformat(),
        bar_start_ms=bars._stamp(day),
        **evidence,
    )


def _volume(leaf, series, window, expected, anchor):
    basis = getattr(leaf.params, "volume_basis", None) or "share_adjusted"
    quantities = {day: series.quantity(day, anchor, basis) for day in expected}
    if any(value is None for value in quantities.values()):
        return [], "share_evidence_unavailable" if basis == "share_adjusted" else "invalid_daily_rows"
    volumes = [sum((quantities[day] for day in bucket), Fraction()) for bucket, _, _ in window]
    maximum = max(volumes)
    if volumes[-1] <= 0 or volumes[-1] < maximum:
        return [], None
    event = _event(
        leaf,
        window[-1][0][0],
        volume_evidence=ScreenerVolumeEvidence(
            basis=basis,
            original_volume=str(sum(series.original[day]["volume"] for day in window[-1][0])),
            compared_volume=str(volumes[-1]),
            maximum=str(maximum),
            window_start=expected[0].isoformat(),
            window_end=anchor.isoformat(),
        ),
    )
    return [event], None


def _turnover(leaf, series, window, expected):
    if any(series.amount(day) is None for day in expected):
        return [], "invalid_daily_rows"
    bucket = window[-1][0]
    amount = sum(series.amount(day) for day in bucket)
    methods = {
        "provider_actual" if series.original[day].get("trade_value_won") is not None else "ohlcv_estimate"
        for day in bucket
    }
    method = next(iter(methods)) if len(methods) == 1 else "mixed_daily"
    if amount < leaf.params.min_eok * 100_000_000:
        return [], None
    return [
        _event(leaf, bucket[0], amount_evidence=ScreenerAmountEvidence(trade_value_won=amount, method=method))
    ], None


def _price(leaf, series, window, expected, days, clock):
    if any(day not in series.prices for day in expected):
        return [], "vendor_price_unavailable"
    anchor = expected[-1]
    if leaf.type == "price_range":
        close = series.prices[anchor]["close"]
        passed = (leaf.params.min is None or close >= leaf.params.min) and (
            leaf.params.max is None or close <= leaf.params.max
        )
        return ([_event(leaf, anchor)] if passed else []), None
    daily = {
        day: bars.VolumeBar(
            bars._stamp(day), 0, **{key: series.prices[day][key] for key in ("open", "high", "low", "close")}
        )
        for day in expected
    }
    # previous_day is the previous trading day, including for W/M.
    previous = days.index(anchor) - 1
    if leaf.type == "change_pct" and previous >= 0 and (day := days[previous]) not in daily and day in series.prices:
        daily[day] = bars.VolumeBar(
            bars._stamp(day), 0, **{key: series.prices[day][key] for key in ("open", "high", "low", "close")}
        )
    grouped = bars.calendar_bars(daily, days, timeframe=leaf.params.timeframe, as_of=clock, windows=window)
    p = leaf.params.model_copy(update={"lookback": 1}) if hasattr(leaf.params, "lookback") else leaf.params
    candidate = leaf.model_copy(update={"params": p})
    found, complete = bars.records(candidate, grouped, fetched_at_ms=int(clock.timestamp() * 1000))
    for event in found:
        event.condition_key = condition_key(leaf, calculation_policy=POLICY)
    return found, None if complete else "insufficient_history"


def _evaluate_window(leaf, series, window, calendar_ok, days, clock):
    if not calendar_ok:
        return [], "calendar_unavailable"
    expected = [day for bucket, _, _ in window for day in bucket]
    if leaf.type in VOLUME_TYPES | TRADE_VALUE_TYPES:
        if any(day not in series.original for day in expected):
            return [], "missing_history"
        if any(day in series.conflicts for day in expected):
            return [], "original_observation_conflict"
    if leaf.type in VOLUME_TYPES:
        return _volume(leaf, series, window, expected, expected[-1])
    if leaf.type in TRADE_VALUE_TYPES:
        return _turnover(leaf, series, window, expected)
    return _price(leaf, series, window, expected, days, clock)


def evaluate_leaf(leaf, code: str, series: values.Series, days: list[dt.date], clock: dt.datetime, *, windows=None):
    events, reasons = [], set()
    windows = windows if windows is not None else _windows(leaf, days, clock)
    if not windows:
        reasons.add("insufficient_history")
    for window, calendar_ok in windows:
        if not window:
            reasons.add("insufficient_history")
            continue
        found, reason = _evaluate_window(leaf, series, window, calendar_ok, days, clock)
        events.extend(found)
        if reason:
            reasons.add(reason)
    failures = [BarVolumeCoverageItem(code=code, condition_id=leaf.id, reason=reason) for reason in sorted(reasons)]
    return list({(event.date, event.bar_start_ms): event for event in events}.values()), failures
