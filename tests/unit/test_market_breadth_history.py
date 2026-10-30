import datetime as dt
import math

import polars as pl
import pytest

from hoga.market_breadth_history import (
    benchmark_history,
    breadth_history,
    calendar_grid,
    complete_cohort,
    low_runs,
    percentile_position,
    prior_regimes,
    rank_association,
)

DAYS = [dt.date(2025, 1, 1) + dt.timedelta(days=i) for i in range(130)]


def test_gap_and_ipo_do_not_pull_older_rows_into_the_window_or_shrink_full_divisor():
    rows = [{"code": "old", "date": day, "close": float(i + 1)} for i, day in enumerate(DAYS)]
    rows += [{"code": "ipo", "date": day, "close": float(i + 1)} for i, day in enumerate(DAYS[15:])]
    grid = calendar_grid(pl.DataFrame(rows), ["old", "ipo"], DAYS)
    result = breadth_history(grid)
    assert result[-1, "eligible_count"] == 1
    assert result[-1, "coverage_pct"] == 50
    assert result[-1, "full_score"] is None
    assert result[-1, "eligible_score"] == 100
    assert complete_cohort(grid) == ["old"]
    hole = pl.DataFrame(rows).filter(~((pl.col("code") == "old") & (pl.col("date") == DAYS[-50])))
    assert breadth_history(calendar_grid(hole, ["old", "ipo"], DAYS))[-1, "eligible_count"] == 0


def test_constant_series_is_equal_not_above_and_first_score_needs_120_sessions():
    grid = calendar_grid(
        pl.DataFrame({"code": ["a"] * len(DAYS), "date": DAYS, "close": [10.0] * len(DAYS)}), ["a"], DAYS
    )
    result = breadth_history(grid)
    assert result[118, "full_score"] is None
    assert result[119, "full_score"] == 0


def test_percentile_ties_are_explicit_and_do_not_claim_every_zero_is_unique_extreme():
    result = percentile_position(10, [0, 10, 10, 30])
    assert (result["lower_pct"], result["midrank_pct"], result["inclusive_pct"]) == (25, 50, 75)
    assert percentile_position(10, [])["midrank_pct"] is None


def test_target_and_future_values_cannot_change_the_targets_prior_threshold():
    frame = pl.DataFrame({"date": DAYS[:5], "score": [1.0, 2.0, 3.0, 0.0, 999.0]})
    first = prior_regimes(frame, window=3)
    changed = prior_regimes(
        frame.with_columns(pl.when(pl.col("date") >= DAYS[3]).then(500.0).otherwise(pl.col("score")).alias("score")),
        window=3,
    )
    assert first[3, "prior_q10"] == changed[3, "prior_q10"]
    assert first[3, "regime"] == "low"
    assert first[2, "regime"] == "unavailable"


def test_flat_reference_does_not_create_false_low_and_high_extremes():
    result = prior_regimes(pl.DataFrame({"date": DAYS[:5], "score": [0.0] * 5}), window=3)
    assert result[-1, "regime"] == "flat_reference"


def test_low_sessions_are_counted_as_separate_runs():
    result = low_runs(pl.DataFrame({"date": DAYS[:5], "regime": ["low", "low", "middle", "low", "low"]}))
    assert result == {"runs": 2, "low_days": 4, "longest_run_sessions": 2}


def test_duplicate_and_invalid_prices_are_rejected():
    frame = pl.DataFrame({"code": ["a"], "date": DAYS[:1], "close": [10.0]})
    with pytest.raises(ValueError, match="Duplicate"):
        calendar_grid(pl.concat([frame, frame]), ["a"], DAYS)
    with pytest.raises(ValueError, match="finite"):
        calendar_grid(frame.with_columns(pl.lit(float("nan")).alias("close")), ["a"], DAYS)


def test_benchmark_windows_need_the_full_history_and_use_log_returns():
    days = [dt.date(2020, 1, 1) + dt.timedelta(days=i) for i in range(280)]
    prices = pl.DataFrame({"code": ["b"] * len(days), "date": days, "close": [100.0] * 279 + [50.0]})
    result = benchmark_history(calendar_grid(prices, ["b"], days))
    assert result[250, "drawdown252"] is None
    assert result[251, "drawdown252"] == 0
    assert result[-1, "drawdown252"] == -0.5
    assert result[-1, "return1"] == -0.5
    assert result[-1, "realized_vol20"] == pytest.approx(math.log(2) * math.sqrt(252 / 20))


def test_rank_association_reports_actual_paired_count_and_handles_constant_inputs():
    frame = pl.DataFrame({"score": [1.0, 2.0, 3.0, None], "stress": [-0.5, -0.3, -0.1, 0.0]})
    result = rank_association(frame, "score", "stress")
    assert result["n"] == 3
    assert result["spearman"] == pytest.approx(1)
    assert rank_association(frame.with_columns(pl.lit(1.0).alias("score")), "score", "stress")["spearman"] is None
