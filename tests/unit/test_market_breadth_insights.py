import pytest

from hoga.market_breadth_insights import endpoint_changes, persistence, rolling_flags


def test_exact_equality_is_not_above_and_missing_does_not_shorten_window():
    assert rolling_flags([10.0] * 120)[-1] == (False, False, False)
    assert rolling_flags([10.0] * 119 + [11.0])[-1] == (True, True, True)
    assert rolling_flags([None] + [10.0] * 119)[-1] is None
    assert rolling_flags([None] + [10.0] * 120)[-1] == (False, False, False)
    with pytest.raises(ValueError):
        rolling_flags([float("nan")])


def test_persistence_ties_gaps_and_left_censoring():
    assert persistence([0, 1, 2, 2, 3, 4]) == {"streak": 2, "atLeast": False, "up5": 4}
    assert persistence([None, 1, 2]) == {"streak": 1, "atLeast": True, "up5": None}
    assert persistence([1, None]) == {"streak": None, "atLeast": False, "up5": None}
    assert persistence([1, 2, 3])["atLeast"] is True
    assert persistence([1, 1 + 1e-9])["streak"] == 0


def test_spread_counts_unique_stocks_and_conserves_changes_including_offsets():
    before = {"A": (False, False, False), "B": (True, True, True), "C": (True, False, False)}
    now = {"A": (True, True, False), "B": (False, False, False), "C": (False, True, False)}
    result = endpoint_changes(before, now)
    assert result is not None
    assert (result["improved"], result["declined"], result["unchanged"], result["cancelling"]) == (1, 1, 1, 1)
    assert sum(r["contribution"] for r in result["stocks"]) == pytest.approx(result["change"])
    assert sum(r["contribution"] for r in result["periods"]) == pytest.approx(result["change"])
    assert result["positive"] + result["negative"] == pytest.approx(result["change"])
    assert result["score"] - result["beforeScore"] == pytest.approx(result["change"])


def test_missing_is_unknown_not_zero_and_universe_must_stay_fixed():
    assert endpoint_changes({"A": None}, {"A": (True, True, True)}) is None
    with pytest.raises(ValueError):
        endpoint_changes({"A": (True,) * 3}, {"B": (True,) * 3})
    with pytest.raises(ValueError):
        endpoint_changes({"A": (True,)}, {"A": (False,)})
