"""Calendar gaps, equality, and ETF overlap change the meaning of breadth."""

import datetime as dt
from fractions import Fraction

import pytest

from hoga.market_breadth import Signal, aggregate_codes, aggregate_groups, stock_signals

SESSIONS = [dt.date(2026, 1, 1) + dt.timedelta(days=i) for i in range(125)]


def histories():
    return {
        "up": dict(zip(SESSIONS, range(1, 126), strict=True)),
        "down": dict(zip(SESSIONS, range(126, 1, -1), strict=True)),
        "flat": dict.fromkeys(SESSIONS, 10),
    }


def test_strict_comparison_keeps_flat_prices_separate():
    signals = stock_signals(histories(), SESSIONS)
    result = aggregate_codes(["up", "down", "flat"], signals)
    assert result.score == Fraction(100, 3)
    for period in (20, 60, 120):
        part = result.periods[period]
        assert (part.above, part.equal, part.below, part.unavailable) == (1, 1, 1, 0)
        assert part.coverage_pct == 100
        assert signals["flat"][period].state == "equal"


def test_etf_overlap_does_not_give_multiple_votes_in_overall_score():
    signals = stock_signals(histories(), SESSIONS)
    groups, overall = aggregate_groups({"A": ["up", "down"], "B": ["up", "flat"]}, signals)
    assert groups["A"].score == groups["B"].score == 50
    assert overall.codes == ("down", "flat", "up")
    assert overall.score == Fraction(100, 3)
    _, duplicated_etf = aggregate_groups({"A": ["up", "down"], "B": ["up", "flat"], "C": ["up"]}, signals)
    assert duplicated_etf.score == overall.score


def test_missing_middle_session_is_not_replaced_by_an_older_price_or_a_below_vote():
    data = histories()
    del data["up"][SESSIONS[-80]]
    result = aggregate_codes(["up", "down"], stock_signals(data, SESSIONS))
    assert result.periods[20].above_pct == 50
    assert result.periods[120].unavailable == 1
    assert result.periods[120].below == 1
    assert result.periods[120].coverage_pct == 50
    assert result.periods[120].above_pct is None
    assert result.score is None


def test_missing_latest_close_blocks_all_periods():
    data = histories()
    data["up"][SESSIONS[-1]] = None
    signals = stock_signals(data, SESSIONS)
    assert all(signals["up"][period].state == "unavailable" for period in (20, 60, 120))


@pytest.mark.parametrize("price", [0, -1, float("nan"), float("inf"), True])
def test_invalid_prices_are_rejected(price):
    data = histories()
    data["up"][SESSIONS[-1]] = price
    with pytest.raises(ValueError, match="price|Price"):
        stock_signals(data, SESSIONS)


@pytest.mark.parametrize("sessions", [SESSIONS[::-1], SESSIONS + [SESSIONS[-1]], SESSIONS[:10]])
def test_calendar_must_be_explicit_ordered_unique_and_long_enough(sessions):
    with pytest.raises(ValueError):
        stock_signals(histories(), sessions)


@pytest.mark.parametrize("codes", [[], ["up", "up"], ["unknown"]])
def test_bad_membership_does_not_silently_alter_the_denominator(codes):
    with pytest.raises(ValueError):
        aggregate_codes(codes, stock_signals(histories(), SESSIONS))


def test_future_prices_do_not_enter_the_selected_calendar():
    data = histories()
    data["down"][SESSIONS[-1] + dt.timedelta(days=1)] = 1_000_000
    signals = stock_signals(data, SESSIONS)
    assert all(signals["down"][period].state == "below" for period in (20, 60, 120))


def test_decimal_equality_has_no_float_tolerance_and_single_stock_group_is_supported():
    data = {"a": dict.fromkeys(SESSIONS, "1.1")}
    signals = stock_signals(data, SESSIONS)
    assert signals["a"][120].sma == Fraction(11, 10)
    assert aggregate_codes(["a"], signals).score == 0


def test_unknown_state_cannot_turn_into_a_false_zero_score():
    signals = stock_signals(histories(), SESSIONS)
    signals["up"][20] = Signal(Fraction(1), Fraction(1), "invalid")
    with pytest.raises(ValueError, match="Unknown comparison state"):
        aggregate_codes(["up"], signals)
