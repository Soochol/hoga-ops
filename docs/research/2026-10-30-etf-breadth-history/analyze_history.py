"""Current-constituent historical diagnostics; no trading simulation or future labels."""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import polars as pl

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

HERE = Path(__file__).resolve().parent
ANALYSIS_START = dt.date(2020, 1, 2)
TARGET = dt.date(2026, 10, 29)
MIN_REFERENCE = 252
COVERAGES = (80, 90)
REFERENCES = {"069500": "KODEX 200", "229200": "KODEX 코스닥150"}
SCORE_TOLERANCE = 1e-7
QUALITY_WINDOWS = (20, 120)


def read(name):
    return json.loads((HERE / name).read_text())


def clean(value):
    if isinstance(value, dict):
        return {k: clean(v) for k, v in value.items()}
    if isinstance(value, list):
        return [clean(v) for v in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value


def save(name, value):
    (HERE / name).write_text(
        json.dumps(clean(value), ensure_ascii=False, indent=2, default=str, allow_nan=False) + "\n"
    )


def panel_summary(panel, benchmark):
    available = panel.filter(pl.col("score").is_not_null() & (pl.col("date") >= ANALYSIS_START))
    target = available.filter(pl.col("date") == TARGET)
    prior = available.filter(pl.col("date") < TARGET)
    score = target[0, "score"] if target.height else None
    position = percentile_position(score, prior["score"].to_list()) if score is not None else {"n": prior.height}
    summary = {
        "target_score": score,
        "reference_position": position,
        "reference_first": prior["date"].min(),
        "reference_last": prior["date"].max(),
        "reference_at_least_one_trading_year": prior.height >= MIN_REFERENCE,
        "target_eligible_count": target[0, "eligible_count"] if target.height else None,
        "reference_eligible_count_range": [prior["eligible_count"].min(), prior["eligible_count"].max()],
        "reference_score_range": [prior["score"].min(), prior["score"].max()],
        "walk_forward_low_runs": low_runs(panel.filter(pl.col("date") >= ANALYSIS_START)),
        "current_prior_q10": target[0, "prior_q10"] if target.height else None,
        "current_prior_q90": target[0, "prior_q90"] if target.height else None,
        "current_regime": target[0, "regime"] if target.height else "unavailable",
        "benchmark_associations": {},
        "walk_forward_groups": {},
    }
    for code, name in REFERENCES.items():
        merged = available.join(benchmark.filter(pl.col("code") == code), on="date", how="left")
        summary["benchmark_associations"][code] = {
            "name": name,
            "drawdown252": rank_association(merged, "score", "drawdown252"),
            "realized_vol20": rank_association(merged, "score", "realized_vol20"),
        }
        summary["walk_forward_groups"][code] = (
            merged.group_by("regime")
            .agg(
                pl.len().alias("days"),
                pl.col("drawdown252").count().alias("drawdown_valid_days"),
                pl.col("realized_vol20").count().alias("volatility_valid_days"),
                pl.col("drawdown252").median().alias("median_drawdown252"),
                pl.col("realized_vol20").median().alias("median_realized_vol20"),
                pl.col("return20").median().alias("median_return20"),
            )
            .sort("regime")
            .to_dicts()
        )
    return summary


def benchmark_summary(frame):
    result = {}
    for code, name in REFERENCES.items():
        selected = frame.filter((pl.col("code") == code) & (pl.col("date") >= ANALYSIS_START))
        current = selected.filter(pl.col("date") == TARGET).row(0, named=True)
        past = selected.filter(pl.col("date") < TARGET)
        result[code] = {
            "name": name,
            "current": current,
            "drawdown_percentile": metric_position(current["drawdown252"], past["drawdown252"]),
            "realized_vol_percentile": metric_position(current["realized_vol20"], past["realized_vol20"]),
        }
    return result


def metric_position(value, reference):
    values = reference.drop_nulls().to_list()
    if value is None or not math.isfinite(value):
        return {"n": len(values), "lower_pct": None, "midrank_pct": None, "inclusive_pct": None}
    return percentile_position(value, values)


def historical_examples(panel, benchmarks):
    selected = panel.filter((pl.col("date") >= ANALYSIS_START) & pl.col("score").is_not_null())
    annual = (
        selected.with_columns(pl.col("date").dt.year().alias("year"))
        .sort(["score", "date"])
        .unique(subset="year", keep="first", maintain_order=True)
        .sort("year")
        .select("year", "date", "score", "regime")
    )
    joined = annual.join(benchmarks, on="date", how="left").sort(["year", "code"])
    return joined.select("year", "date", "score", "regime", "code", "drawdown252", "realized_vol20").to_dicts()


def source_coverage(grid, universe):
    metadata = pl.DataFrame(universe).select("code", "name", "listing_date").with_columns(
        pl.col("listing_date").str.to_date(strict=False)
    )
    annotated = grid.join(metadata, on="code", how="left")
    counts = annotated.group_by("code").agg(
        pl.col("close").count().alias("valid_sessions"),
        pl.col("date").filter(pl.col("close").is_not_null()).min().alias("first_valid"),
        pl.col("date").filter(pl.col("close").is_not_null()).max().alias("last_valid"),
        ((pl.col("date") >= pl.col("listing_date")) & pl.col("close").is_null())
        .sum()
        .alias("missing_on_or_after_reported_listing"),
    )
    sessions = sorted(grid["date"].unique())
    for window in QUALITY_WINDOWS:
        tail = grid.filter(pl.col("date").is_in(sessions[-window:])).group_by("code").agg(
            ((pl.col("close").count() == window) & (pl.col("close").n_unique() == 1)).alias(
                f"current_{window}session_price_flat"
            )
        )
        counts = counts.join(tail, on="code")
    return counts.join(metadata, on="code").sort("code")


def analyze():
    source = read("extraction-summary.json")
    if source["recent125_changed_rows"]:
        raise SystemExit("Recent prices changed since the original score; reconcile revisions first")
    frame = pl.read_parquet(HERE / "confirmed-history.parquet")
    sessions = [dt.date.fromisoformat(day) for day in read("calendar.json")]
    universe = json.loads((HERE.parent / "2026-10-30-etf-constituent-validation/universe.json").read_text())
    codes = [r["code"] for r in universe]
    grid = calendar_grid(frame, codes, sessions)
    daily = breadth_history(grid)
    cohort = complete_cohort(grid)
    if not cohort:
        raise SystemExit("No complete fixed historical cohort")
    stable = breadth_history(grid.filter(pl.col("code").is_in(cohort)))
    benchmarks = benchmark_history(calendar_grid(frame, sorted(REFERENCES), sessions))
    panels = {
        "original_477": daily.with_columns(pl.col("full_score").alias("score")),
        "fixed_complete_cohort": stable.with_columns(pl.col("full_score").alias("score")),
    }
    for coverage in COVERAGES:
        panels[f"eligible_min_{coverage}pct"] = daily.with_columns(
            pl.when(pl.col("coverage_pct") >= coverage).then(pl.col("eligible_score")).otherwise(None).alias("score")
        )
    labeled = {name: prior_regimes(panel) for name, panel in panels.items()}
    statistics = {name: panel_summary(panel, benchmarks) for name, panel in labeled.items()}
    original = json.loads((HERE.parent / "2026-10-30-etf-breadth/overall.json").read_text())
    if abs(statistics["original_477"]["target_score"] - original["primary"]["score"]) > SCORE_TOLERANCE:
        raise ValueError("Original 477-stock current score did not reproduce")
    result = {
        "source_snapshot": source["snapshot_id"],
        "price_anchor": source["adjusted_as_of"],
        "target": TARGET,
        "analysis_from": ANALYSIS_START,
        "cohort_size": len(cohort),
        "cohort_codes": cohort,
        "current_477_score": original["primary"]["score"],
        "panels": statistics,
        "benchmarks": benchmark_summary(benchmarks),
        "scope": "retrospective current-constituent diagnostics; survivorship and selection bias remain",
        "daily_observations_are_not_independent": True,
        "score_weights_unchanged": True,
    }
    save("summary.json", result)
    combined = pl.concat([panel.with_columns(pl.lit(name).alias("panel")) for name, panel in labeled.items()])
    combined.write_parquet(HERE / "daily-panels.parquet")
    benchmarks.write_parquet(HERE / "benchmark-metrics.parquet")
    save("coverage.json", source_coverage(grid, universe).to_dicts())
    save("historical-examples.json", historical_examples(labeled["fixed_complete_cohort"], benchmarks))
    save(
        "plot-data.json",
        {
            "summary": result,
            "daily": combined.filter(pl.col("date") >= ANALYSIS_START).to_dicts(),
            "benchmarks": benchmarks.filter(pl.col("date") >= ANALYSIS_START).to_dicts(),
        },
    )
    print(
        json.dumps(
            {
                "cohort_size": len(cohort),
                "panels": {
                    name: {
                        "current": stats["target_score"],
                        "position": stats["reference_position"],
                        "regime": stats["current_regime"],
                    }
                    for name, stats in statistics.items()
                },
            },
            ensure_ascii=False,
            indent=2,
            default=str,
        )
    )


if __name__ == "__main__":
    analyze()
