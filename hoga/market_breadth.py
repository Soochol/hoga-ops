"""Equal-stock breadth from an explicitly supplied, aligned price snapshot.

This policy measures price breadth, not observed investor psychology. Callers
must supply confirmed adjusted closes on one basis and an explicit calendar.
Missing sessions never become zero prices, below-MA votes, or a smaller divisor.
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from fractions import Fraction
from typing import Literal

POLICY_ID = "etf_ma_breadth_v1"
PERIODS = (20, 60, 120)
State = Literal["above", "equal", "below", "unavailable"]


@dataclass(frozen=True)
class Signal:
    close: Fraction | None
    sma: Fraction | None
    state: State
    missing_dates: tuple[dt.date, ...] = ()


@dataclass(frozen=True)
class PeriodBreadth:
    total: int
    above: int
    equal: int
    below: int
    unavailable: int

    @property
    def coverage_pct(self) -> Fraction:
        return Fraction((self.total - self.unavailable) * 100, self.total)

    @property
    def above_pct(self) -> Fraction | None:
        return None if self.unavailable else Fraction(self.above * 100, self.total)


@dataclass(frozen=True)
class Breadth:
    codes: tuple[str, ...]
    periods: dict[int, PeriodBreadth]

    @property
    def score(self) -> Fraction | None:
        percentages = [self.periods[period].above_pct for period in PERIODS]
        return None if any(value is None for value in percentages) else sum(percentages) / len(PERIODS)


def _positive_price(value) -> Fraction:
    if isinstance(value, bool):
        raise ValueError("Boolean is not a price")
    try:
        price = Fraction(str(value))
    except (ValueError, ZeroDivisionError) as error:
        raise ValueError("Price must be finite and positive") from error
    if price <= 0:
        raise ValueError("Price must be finite and positive")
    return price


def stock_signals(
    histories: Mapping[str, Mapping[dt.date, object]],
    sessions: Sequence[dt.date],
) -> dict[str, dict[int, Signal]]:
    """Evaluate close > SMA on exact required sessions, including the target close."""
    if not sessions or list(sessions) != sorted(set(sessions)):
        raise ValueError("Sessions must be nonempty, ordered, and unique")
    if len(sessions) < max(PERIODS):
        raise ValueError("The explicit calendar must contain at least 120 sessions")
    result = {}
    for code, history in histories.items():
        valid = {day: _positive_price(history[day]) for day in sessions if history.get(day) is not None}
        per_period = {}
        for period in PERIODS:
            required = sessions[-period:]
            missing = tuple(day for day in required if day not in valid)
            close = valid.get(sessions[-1])
            if missing:
                per_period[period] = Signal(close, None, "unavailable", missing)
                continue
            sma = sum(valid[day] for day in required) / period
            state: State = "above" if close > sma else "below" if close < sma else "equal"
            per_period[period] = Signal(close, sma, state)
        result[code] = per_period
    return result


def aggregate_codes(codes: Sequence[str], signals: Mapping[str, Mapping[int, Signal]]) -> Breadth:
    if not codes or len(set(codes)) != len(codes):
        raise ValueError("Constituents must be nonempty and unique within each group")
    if set(codes) - signals.keys():
        raise ValueError("Constituent has no signal record")
    periods = {}
    for period in PERIODS:
        counts = Counter(signals[code][period].state for code in codes)
        if counts.keys() - {"above", "equal", "below", "unavailable"}:
            raise ValueError("Unknown comparison state")
        periods[period] = PeriodBreadth(
            len(codes), counts["above"], counts["equal"], counts["below"], counts["unavailable"]
        )
    return Breadth(tuple(sorted(codes)), periods)


def aggregate_groups(
    groups: Mapping[str, Sequence[str]],
    signals: Mapping[str, Mapping[int, Signal]],
) -> tuple[dict[str, Breadth], Breadth]:
    per_group = {name: aggregate_codes(codes, signals) for name, codes in groups.items()}
    union = sorted({code for group in per_group.values() for code in group.codes})
    return per_group, aggregate_codes(union, signals)
