"""Independent NumPy checks against every reported daily score and stress metric.

Does not import either breadth implementation. Runs entirely on frozen research
artifacts and checks all dates, missing-session masks, counts and prior cutoffs.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import subprocess
import sys
from pathlib import Path

import numpy as np
import polars as pl

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
OUTPUTS = (
    "summary.json", "daily-panels.parquet", "benchmark-metrics.parquet", "coverage.json", "plot-data.json",
    "historical-examples.json",
)
TOLERANCE = 1e-9
REFERENCE_WINDOW = 252
VOLATILITY_WINDOW = 20


def read(name):
    return json.loads((HERE / name).read_text())


def digest(name):
    return hashlib.sha256((HERE / name).read_bytes()).hexdigest()


def matrix(frame, codes, sessions):
    rows, columns = {code: i for i, code in enumerate(codes)}, {day: i for i, day in enumerate(sessions)}
    values = np.full((len(codes), len(sessions)), np.nan)
    seen = set()
    for code, day, close in frame.select("code", "date", "close").iter_rows():
        if code not in rows:
            continue
        assert (code, day) not in seen
        seen.add((code, day))
        assert day in columns and close > 0 and math.isfinite(close)
        values[rows[code], columns[day]] = close
    return values


def independent_panel(values):
    eligible = np.zeros(values.shape, dtype=bool)
    windows120 = np.lib.stride_tricks.sliding_window_view(values, 120, axis=1)
    eligible[:, 119:] = np.isfinite(windows120).all(axis=2)
    above = []
    for period in (20, 60, 120):
        windows = np.lib.stride_tricks.sliding_window_view(values, period, axis=1)
        means = np.full(values.shape, np.nan)
        means[:, period - 1 :] = windows.mean(axis=2)
        above.append(((values > means) & eligible).sum(axis=0))
    count = eligible.sum(axis=0)
    score = np.full(count.shape, np.nan)
    np.divide(100 * np.sum(above, axis=0), 3 * count, out=score, where=count > 0)
    return count, above, score


def equal_numbers(actual, expected):
    return bool(np.allclose(np.asarray(actual, dtype=float), expected, atol=TOLERANCE, rtol=0, equal_nan=True))


def check_thresholds(panel, scores):
    checked = 0
    for i, row in enumerate(panel.iter_rows(named=True)):
        previous = scores[max(0, i - REFERENCE_WINDOW) : i]
        if len(previous) < REFERENCE_WINDOW or not np.isfinite(previous).all():
            assert row["prior_q10"] is None and row["prior_q90"] is None
            assert row["regime"] == "unavailable"
            continue
        q10, q90 = np.quantile(previous, [0.1, 0.9], method="linear")
        assert equal_numbers([row["prior_q10"], row["prior_q90"]], [q10, q90])
        actual = scores[i]
        regime = (
            "unavailable" if not math.isfinite(actual) else
            "flat_reference" if q10 == q90 else
            "low" if actual <= q10 else "high" if actual >= q90 else "middle"
        )
        assert row["regime"] == regime, row["date"]
        checked += 1
    return checked


def check_benchmarks(frame, sessions):
    benchmark = pl.read_parquet(HERE / "benchmark-metrics.parquet")
    for code in ("069500", "229200"):
        prices = matrix(frame, [code], sessions)[0]
        panel = benchmark.filter(pl.col("code") == code).sort("date")
        metrics = {key: [] for key in ("drawdown252", "realized_vol20", "return1", "return20")}
        with np.errstate(invalid="ignore", divide="ignore"):
            log_returns = np.diff(np.log(prices))
        for i, price in enumerate(prices):
            metrics["drawdown252"].append(
                price / np.max(prices[i - REFERENCE_WINDOW + 1 : i + 1]) - 1
                if i >= REFERENCE_WINDOW - 1 else np.nan
            )
            metrics["realized_vol20"].append(
                np.std(log_returns[i - VOLATILITY_WINDOW : i], ddof=1) * math.sqrt(REFERENCE_WINDOW)
                if i >= VOLATILITY_WINDOW else np.nan
            )
            metrics["return1"].append(price / prices[i - 1] - 1 if i else np.nan)
            metrics["return20"].append(
                price / prices[i - VOLATILITY_WINDOW] - 1 if i >= VOLATILITY_WINDOW else np.nan
            )
        for key, values in metrics.items():
            assert equal_numbers(panel[key].to_list(), values), (code, key)
    return benchmark.height


def validate():
    frame = pl.read_parquet(HERE / "confirmed-history.parquet")
    sessions = [dt.date.fromisoformat(day) for day in read("calendar.json")]
    universe = json.loads((HERE.parent / "2026-10-30-etf-constituent-validation/universe.json").read_text())
    codes = [row["code"] for row in universe]
    all_prices = matrix(frame, codes, sessions)
    selected = np.isfinite(all_prices).all(axis=1)
    assert sorted(codes[i] for i in np.flatnonzero(selected)) == read("summary.json")["cohort_codes"]
    panels = pl.read_parquet(HERE / "daily-panels.parquet")
    count, above, score = independent_panel(all_prices)
    full_score = np.where(count == len(codes), score, np.nan)
    expected = {"original_477": (count, above, full_score, len(codes))}
    cohort_count, cohort_above, cohort_score = independent_panel(all_prices[selected])
    expected["fixed_complete_cohort"] = (cohort_count, cohort_above, cohort_score, int(selected.sum()))
    for minimum in (80, 90):
        expected[f"eligible_min_{minimum}pct"] = (
            count, above, np.where(100 * count / len(codes) >= minimum, score, np.nan), len(codes)
        )
    checks = {}
    for name, (expected_count, expected_above, expected_score, size) in expected.items():
        panel = panels.filter(pl.col("panel") == name).sort("date")
        assert panel["date"].to_list() == sessions
        assert panel["eligible_count"].to_list() == expected_count.tolist(), name
        assert panel["population_count"].to_list() == [size] * len(sessions), name
        assert equal_numbers(panel["score"].to_list(), expected_score), name
        for period, reference in zip((20, 60, 120), expected_above, strict=True):
            assert panel[f"above{period}"].to_list() == reference.tolist(), (name, period)
        checks[name] = {"daily_rows": panel.height, "prior_threshold_dates": check_thresholds(panel, expected_score)}
        target = expected_score[-1]
        past = expected_score[(np.array(sessions) >= dt.date(2020, 1, 2)) & (np.array(sessions) < sessions[-1])]
        past = past[np.isfinite(past)]
        summary = read("summary.json")["panels"][name]["reference_position"]
        assert summary["n"] == len(past)
        if math.isfinite(target):
            midrank = 100 * ((past < target).sum() + 0.5 * (past == target).sum()) / len(past)
            assert equal_numbers([summary["midrank_pct"]], [midrank])
    benchmark_dates = check_benchmarks(frame, sessions)
    before = {name: digest(name) for name in OUTPUTS}
    result = subprocess.run(
        [sys.executable, str(HERE / "analyze_history.py")], capture_output=True, text=True, check=True
    )
    (HERE / "replay-output.txt").write_text(result.stdout)
    after = {name: digest(name) for name in OUTPUTS}
    assert before == after, "Analysis outputs are not byte-reproducible"
    record = {
        "independent_numpy_checks_passed": True,
        "panels": checks,
        "benchmark_metric_dates": benchmark_dates,
        "recent125_price_changes": read("recent125-comparison.json")["changed_or_missing_rows"],
        "replay_hashes_identical": True,
        "output_sha256": after,
        "input_sha256": {
            name: digest(name) for name in (
                "analysis-spec.json", "analyze_history.py", "validate_history.py", "confirmed-history.parquet",
                "calendar.json", "source-observations.json",
            )
        },
        "python": sys.version,
        "numpy": np.__version__,
        "polars": pl.__version__,
        "tolerance": TOLERANCE,
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=REPO, text=True).strip(),
        "repo_input_sha256": {
            name: hashlib.sha256((REPO / name).read_bytes()).hexdigest()
            for name in (
                "hoga/market_breadth.py", "hoga/market_breadth_history.py",
                "tests/unit/test_market_breadth.py", "tests/unit/test_market_breadth_history.py",
                "pyproject.toml", "uv.lock",
            )
        },
    }
    (HERE / "validation.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(record, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    validate()
