"""Endpoint breadth changes. One stock, one vote per MA; no holdings weights.

Prices must already share a confirmed adjustment anchor and explicit session grid.
Missing windows stay unavailable. Contributions use rational arithmetic so their
sum is exactly the aggregate score change, including offsetting MA switches.
"""

from collections.abc import Mapping, Sequence
from fractions import Fraction
from math import isfinite

PERIODS = (20, 60, 120)
MAX_SCORE = 100
PAIR_SIZE = 2
RECENT_TRANSITIONS = 5
SCORE_TOLERANCE = 1e-7


def rolling_flags(prices: Sequence[float | None]) -> list[tuple[bool, ...] | None]:
    """Strict close > SMA for all three periods; never skip missing sessions."""
    sums = [Fraction(0)]
    missing = [0]
    parsed = []
    for price in prices:
        if price is not None and (not isfinite(price) or price <= 0):
            raise ValueError("Prices must be finite and positive")
        value = Fraction(str(price)) if price is not None else None
        parsed.append(value)
        sums.append(sums[-1] + (value or 0))
        missing.append(missing[-1] + (value is None))
    result = []
    for i, value in enumerate(parsed):
        if i < max(PERIODS) - 1 or missing[i + 1] != missing[i + 1 - max(PERIODS)]:
            result.append(None)
        else:
            assert value is not None
            result.append(tuple(value * p > sums[i + 1] - sums[i + 1 - p] for p in PERIODS))
    return result


def persistence(scores: Sequence[float | None]) -> dict:
    """Consecutive strict increases; a tie breaks the run, missing is unknown."""
    if any(v is not None and (not isfinite(v) or not 0 <= v <= MAX_SCORE) for v in scores):
        raise ValueError("Scores must be finite and between 0 and 100")
    streak = None
    censored = False
    if len(scores) >= PAIR_SIZE and scores[-1] is not None and scores[-2] is not None:
        streak = 0
        for i in range(len(scores) - 1, 0, -1):
            now, before = scores[i], scores[i - 1]
            if now is None or before is None:
                censored = True
                break
            if now - before <= SCORE_TOLERANCE:
                break
            streak += 1
        else:
            censored = True
    tail = scores[-(RECENT_TRANSITIONS + 1) :]
    up5 = None
    if len(tail) == RECENT_TRANSITIONS + 1 and all(v is not None for v in tail):
        up5 = sum(tail[i] - tail[i - 1] > SCORE_TOLERANCE for i in range(1, RECENT_TRANSITIONS + 1))
    return {"streak": streak, "atLeast": censored, "up5": up5}


def endpoint_changes(
    before: Mapping[str, tuple[bool, ...] | None],
    now: Mapping[str, tuple[bool, ...] | None],
) -> dict | None:
    """Deduplicated stock spread and additive score attribution for fixed codes."""
    if not before or before.keys() != now.keys():
        raise ValueError("Endpoint universes must be identical and nonempty")
    if any(v is None for v in (*before.values(), *now.values())):
        return None
    unit = Fraction(100, len(now) * len(PERIODS))
    rows = []
    improved = declined = unchanged = cancelling = 0
    entries, exits = [0] * 3, [0] * 3
    total_before = total_now = 0
    for code in sorted(now):
        old, new = before[code], now[code]
        assert old is not None and new is not None
        if len(old) != len(PERIODS) or len(new) != len(PERIODS) or any(type(v) is not bool for v in (*old, *new)):
            raise ValueError("Each stock needs three boolean MA states")
        changes = [int(b) - int(a) for a, b in zip(old, new, strict=True)]
        delta = sum(changes)
        improved += delta > 0
        declined += delta < 0
        unchanged += delta == 0
        cancelling += delta == 0 and any(changes)
        for j, value in enumerate(changes):
            entries[j] += value > 0
            exits[j] += value < 0
        total_before += sum(old)
        total_now += sum(new)
        rows.append(
            {"code": code, "before": sum(old), "now": sum(new), "changes": changes, "contribution": float(delta * unit)}
        )
    exact_total = (total_now - total_before) * unit
    assert sum((sum(row["changes"]) * unit for row in rows), Fraction(0)) == exact_total
    return {
        "population": len(now),
        "improved": improved,
        "declined": declined,
        "unchanged": unchanged,
        "cancelling": cancelling,
        "beforeScore": float(total_before * unit),
        "score": float(total_now * unit),
        "change": float(exact_total),
        "positive": float(sum((max(0, sum(r["changes"])) * unit for r in rows), Fraction(0))),
        "negative": float(sum((min(0, sum(r["changes"])) * unit for r in rows), Fraction(0))),
        "periods": [
            {
                "period": p,
                "entry": entries[j],
                "exit": exits[j],
                "net": entries[j] - exits[j],
                "contribution": float((entries[j] - exits[j]) * unit),
            }
            for j, p in enumerate(PERIODS)
        ],
        "stocks": rows,
    }
