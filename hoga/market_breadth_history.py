"""Retrospective current-cohort breadth diagnostics with explicit missing sessions.

Historical ETF membership and investor sentiment are not inferred from prices.
All percentile thresholds use earlier observations only.
"""

from __future__ import annotations

import datetime as dt
import math
from collections.abc import Sequence

import polars as pl

from hoga.market_breadth import PERIODS

TRADING_YEAR = 252
VOLATILITY_WINDOW = 20
MIN_REFERENCE_SESSIONS = 2
MIN_CORRELATION_PAIRS = 3


def calendar_grid(prices: pl.DataFrame, codes: Sequence[str], sessions: Sequence[dt.date]) -> pl.DataFrame:
    if not codes or len(codes) != len(set(codes)):
        raise ValueError("Stock universe must be nonempty and unique")
    if not sessions or list(sessions) != sorted(set(sessions)):
        raise ValueError("Calendar must be nonempty, ordered and unique")
    selected = prices.filter(pl.col("code").is_in(codes)).select("code", "date", "close")
    if selected.select(pl.struct("code", "date").n_unique()).item() != selected.height:
        raise ValueError("Duplicate stock/date")
    if selected.filter(~pl.col("date").is_in(sessions)).height:
        raise ValueError("Price outside the explicit calendar")
    if selected.filter(pl.col("close").is_null() | ~pl.col("close").is_finite() | (pl.col("close") <= 0)).height:
        raise ValueError("Price must be finite and positive; omit unavailable rows")
    return (
        pl.DataFrame({"code": list(codes)})
        .join(pl.DataFrame({"date": list(sessions)}), how="cross")
        .join(selected, on=["code", "date"], how="left")
        .sort(["code", "date"])
    )


def breadth_history(grid: pl.DataFrame) -> pl.DataFrame:
    """Daily eligible pool and the strict full-universe score, preserving IPO/gap masks."""
    size = grid["code"].n_unique()
    if not size:
        raise ValueError("Empty price grid")
    signals = (
        grid.sort(["code", "date"])
        .with_columns(
            *[pl.col("close").rolling_mean(window_size=p, min_samples=p).over("code").alias(f"sma{p}") for p in PERIODS]
        )
        .with_columns(pl.all_horizontal(*[pl.col(f"sma{p}").is_not_null() for p in PERIODS]).alias("eligible"))
    )
    daily = (
        signals.group_by("date")
        .agg(
            pl.col("eligible").sum().alias("eligible_count"),
            *[((pl.col("close") > pl.col(f"sma{p}")) & pl.col("eligible")).sum().alias(f"above{p}") for p in PERIODS],
        )
        .sort("date")
        .with_columns(
            pl.lit(size).alias("population_count"),
            (100 * pl.col("eligible_count") / size).alias("coverage_pct"),
            *[
                pl.when(pl.col("eligible_count") > 0)
                .then(100 * pl.col(f"above{p}") / pl.col("eligible_count"))
                .otherwise(None)
                .alias(f"breadth{p}")
                for p in PERIODS
            ],
            pl.when(pl.col("eligible_count") > 0)
            .then(
                100
                * pl.sum_horizontal(*[pl.col(f"above{p}") for p in PERIODS])
                / (len(PERIODS) * pl.col("eligible_count"))
            )
            .otherwise(None)
            .alias("eligible_score"),
        )
    )
    return daily.with_columns(
        pl.when(pl.col("eligible_count") == size).then(pl.col("eligible_score")).otherwise(None).alias("full_score")
    )


def complete_cohort(grid: pl.DataFrame) -> list[str]:
    expected = grid["date"].n_unique()
    counts = grid.group_by("code").agg(pl.col("close").count().alias("available"))
    return sorted(counts.filter(pl.col("available") == expected)["code"])


def percentile_position(value: float, reference: Sequence[float]) -> dict:
    if not math.isfinite(value) or any(not math.isfinite(v) for v in reference):
        raise ValueError("Percentiles require finite observations")
    if not reference:
        return {"n": 0, "lower_pct": None, "midrank_pct": None, "inclusive_pct": None}
    lower = sum(v < value for v in reference)
    equal = sum(v == value for v in reference)
    size = len(reference)
    return {
        "n": size,
        "lower_count": lower,
        "equal_count": equal,
        "lower_pct": 100 * lower / size,
        "midrank_pct": 100 * (lower + equal / 2) / size,
        "inclusive_pct": 100 * (lower + equal) / size,
    }


def prior_regimes(frame: pl.DataFrame, *, window: int = TRADING_YEAR) -> pl.DataFrame:
    if window < MIN_REFERENCE_SESSIONS:
        raise ValueError("Reference window must contain at least two sessions")
    ordered = frame.sort("date")
    if ordered["date"].n_unique() != ordered.height:
        raise ValueError("Daily panel must have unique dates")
    thresholds = ordered.with_columns(
        pl.col("score")
        .shift(1)
        .rolling_quantile(quantile=0.1, interpolation="linear", window_size=window, min_samples=window)
        .alias("prior_q10"),
        pl.col("score")
        .shift(1)
        .rolling_quantile(quantile=0.9, interpolation="linear", window_size=window, min_samples=window)
        .alias("prior_q90"),
    )
    return thresholds.with_columns(
        pl.when(pl.col("score").is_null() | pl.col("prior_q10").is_null())
        .then(pl.lit("unavailable"))
        .when(pl.col("prior_q10") == pl.col("prior_q90"))
        .then(pl.lit("flat_reference"))
        .when(pl.col("score") <= pl.col("prior_q10"))
        .then(pl.lit("low"))
        .when(pl.col("score") >= pl.col("prior_q90"))
        .then(pl.lit("high"))
        .otherwise(pl.lit("middle"))
        .alias("regime")
    )


def benchmark_history(grid: pl.DataFrame) -> pl.DataFrame:
    frame = grid.sort(["code", "date"]).with_columns(
        (pl.col("close") / pl.col("close").shift(1).over("code")).log().alias("log_return"),
        (pl.col("close") / pl.col("close").shift(1).over("code") - 1).alias("return1"),
        (pl.col("close") / pl.col("close").shift(VOLATILITY_WINDOW).over("code") - 1).alias("return20"),
        (
            pl.col("close")
            / pl.col("close").rolling_max(window_size=TRADING_YEAR, min_samples=TRADING_YEAR).over("code")
            - 1
        ).alias("drawdown252"),
    )
    return frame.with_columns(
        (
            pl.col("log_return")
            .rolling_std(window_size=VOLATILITY_WINDOW, min_samples=VOLATILITY_WINDOW, ddof=1)
            .over("code")
            * math.sqrt(TRADING_YEAR)
        ).alias("realized_vol20")
    )


def rank_association(frame: pl.DataFrame, left: str, right: str) -> dict:
    paired = frame.select(left, right).drop_nulls().filter(pl.col(left).is_finite(), pl.col(right).is_finite())
    value = None
    if paired.height >= MIN_CORRELATION_PAIRS and paired[left].n_unique() > 1 and paired[right].n_unique() > 1:
        value = paired.select(pl.corr(left, right, method="spearman")).item()
    return {"n": paired.height, "spearman": value}


def low_runs(frame: pl.DataFrame) -> dict:
    """Count clusters of adjacent low-score sessions, rather than independent daily events."""
    sizes, current = [], 0
    for regime in frame.sort("date")["regime"]:
        if regime == "low":
            current += 1
        elif current:
            sizes.append(current)
            current = 0
    if current:
        sizes.append(current)
    return {"runs": len(sizes), "low_days": sum(sizes), "longest_run_sessions": max(sizes, default=0)}
