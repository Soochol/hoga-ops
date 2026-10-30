"""Independent Polars reconciliation, deterministic rerun, and input fingerprints."""

from __future__ import annotations

import hashlib
import json
import platform
import re
import subprocess
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
PERIODS = (20, 60, 120)
EXPECTED_STOCKS = 477
EXPECTED_ETFS = 38
EXPECTED_MEMBERSHIPS = 757
FULL_COVERAGE_PCT = 100
OUTPUT_ROUNDING_TOLERANCE = 1e-7


def read(path):
    return json.loads(path.read_text())


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(command):
    result = subprocess.run(command, cwd=ROOT, text=True, capture_output=True, check=True)
    return {"command": command, "returncode": result.returncode, "stdout": result.stdout.strip()}


def independent_counts():
    frame = pl.read_parquet(HERE.parent / "2026-10-30-etf-confirmed-observations/confirmed-adjusted.parquet")
    values = (
        frame.sort(["code", "date"])
        .with_columns(*[pl.col("close").rolling_mean(window_size=p).over("code").alias(f"sma{p}") for p in PERIODS])
        .group_by("code", maintain_order=True)
        .last()
    )
    assert values.height == EXPECTED_STOCKS
    return {
        p: {
            "above": set(values.filter(pl.col("close") > pl.col(f"sma{p}"))["code"]),
            "equal": set(values.filter(pl.col("close") == pl.col(f"sma{p}"))["code"]),
            "below": set(values.filter(pl.col("close") < pl.col(f"sma{p}"))["code"]),
        }
        for p in PERIODS
    }


def reconcile():
    overall, etfs = read(HERE / "overall.json"), read(HERE / "etf-breadth.json")
    independent = independent_counts()
    assert len(etfs) == EXPECTED_ETFS
    assert sum(r["constituent_count"] for r in etfs) == EXPECTED_MEMBERSHIPS
    union = {code for etf in etfs for code in etf["codes"]}
    assert len(union) == EXPECTED_STOCKS and union == set(overall["primary"]["codes"])
    alternate = overall["known_halt_excluded_sensitivity"]
    for etf in [*etfs, overall["primary"], alternate]:
        codes, parts = set(etf["codes"]), etf["periods"]
        for p in PERIODS:
            counts = parts[str(p)]
            assert counts["denominator"] == len(codes) and counts["unavailable"] == 0
            assert counts["coverage_pct"] == FULL_COVERAGE_PCT
            for state in ("above", "equal", "below"):
                assert counts[state] == len(codes & independent[p][state])
            assert sum(counts[state] for state in ("above", "equal", "below")) == len(codes)
            assert abs(counts["above_pct"] - 100 * counts["above"] / len(codes)) < OUTPUT_ROUNDING_TOLERANCE
        expected = sum(100 * parts[str(p)]["above"] / len(codes) for p in PERIODS) / len(PERIODS)
        assert abs(etf["score"] - expected) < OUTPUT_ROUNDING_TOLERANCE
    assert set(alternate["codes"]) == union - set(alternate["excluded_codes"])
    for p in PERIODS:
        assert alternate["periods"][str(p)]["above"] == len(set(alternate["codes"]) & independent[p]["above"])
    # Independent stock-level classification must agree too, including exact ties.
    for stock in read(HERE / "stock-signals.json"):
        for p in PERIODS:
            assert stock["code"] in independent[p][stock["periods"][str(p)]["state"]]


def validate():
    targets = [
        "hoga/market_breadth.py",
        "tests/unit/test_market_breadth.py",
        str(HERE.relative_to(ROOT) / "calculate_breadth.py"),
        str(Path(__file__).relative_to(ROOT)),
    ]
    lint = run(["uv", "run", "--extra", "dev", "ruff", "check", *targets])
    tests = run(["uv", "run", "--extra", "dev", "pytest", "-q", "tests/unit/test_market_breadth.py"])
    reconcile()
    results = [
        HERE / name
        for name in (
            "overall.json",
            "etf-breadth.json",
            "stock-signals.json",
            "policy.json",
            "verification.json",
            "README.md",
        )
    ]
    before = {f.name: sha(f) for f in results}
    rebuild = run(["uv", "run", "--extra", "dev", "python", str(HERE / "calculate_breadth.py")])
    assert {f.name: sha(f) for f in results} == before
    evidence = {
        "checks": {
            key: "passed"
            for key in (
                "independent_polars_rolling_mean_for_all_477_stocks",
                "all_38_etf_counts_and_scores",
                "deduplicated_477_union_not_757_memberships",
                "exact_ties_distinguished_from_strict_above",
                "known_halt_sensitivity_divisor",
                "all_six_outputs_identical_on_rebuild",
            )
        },
        "python": platform.python_version(),
        "polars": pl.__version__,
        "git_head": subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip(),
        "local_main": subprocess.check_output(["git", "rev-parse", "main"], cwd=ROOT, text=True).strip(),
        "commands": [lint, tests, rebuild],
        "output_sha256": {f.name: sha(f) for f in results},
        "calculation_inputs_sha256": {
            name: sha(ROOT / name)
            for name in [
                *targets,
                "pyproject.toml",
                "uv.lock",
                "ruff.toml",
                "CONTEXT.md",
            ]
        },
    }
    (HERE / "validation.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n")
    for href in re.findall(r"\]\(([^)]+)\)", (HERE / "README.md").read_text()):
        if not href.startswith("https://"):
            assert (HERE / href).exists(), href
    print("Independent rolling-mean, 38 ETF, union, sensitivity, rerun, unit and lint checks passed.")


if __name__ == "__main__":
    validate()
