"""Reconcile issuer and daily-audit artifacts independently, without network."""

from __future__ import annotations

import collections
import hashlib
import json
import platform
import re
import subprocess
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
EXPECTED_ETFS = 38
EXPECTED_STOCKS = 477
EXPECTED_MEMBERSHIPS = 757
EXPECTED_SESSIONS = 125
EXPECTED_CONFIRMED = 7


def read(name):
    return json.loads((HERE / name).read_text())


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def command(*args):
    return subprocess.check_output(args, cwd=ROOT, text=True).strip()


def main():
    scripts = [str(path.relative_to(ROOT)) for path in sorted(HERE.glob("*.py"))]
    lint = command("uv", "run", "--extra", "dev", "ruff", "check", *scripts)
    source_names = (
        "screener_series_values.py",
        "screener_series_store.py",
        "screener_daily_confirmation.py",
        "screener_daily_quality.py",
        "screener_corrections.py",
        "trading_days.py",
    )
    unchanged = command(
        "git", "diff", "--name-only", "HEAD", "main", "--", *["hoga/api/" + name for name in source_names]
    )
    assert not unchanged, "Read semantics changed on main; review before reusing this audit."
    specs = read("issuer-source-manifest.json")
    for spec in specs:
        assert sha(HERE / "issuer-responses" / spec["file"]) == spec["saved_sha256"]
    comparisons = read("issuer-comparison.json")
    assert len(comparisons) == EXPECTED_ETFS
    assert all(x["stock_codes_and_cu_quantities_equal"] and not x["cash_quantity_differences"] for x in comparisons)
    assert sum(x["issuer_rows"] for x in comparisons) == EXPECTED_MEMBERSHIPS + EXPECTED_ETFS
    members, stocks = read("memberships.json"), read("universe.json")
    assert len(members) == EXPECTED_MEMBERSHIPS and len(stocks) == EXPECTED_STOCKS
    assert {x["componentItemCode"] for x in members} == {x["code"] for x in stocks}
    assert len(read("excluded-assets.json")) == EXPECTED_ETFS
    pairs = [(x["etf_code"], x["componentItemCode"]) for x in members]
    assert len(set(pairs)) == len(pairs)
    assert all(x["security_type"] == "stock" for x in stocks)
    calendar = read("daily-evidence/calendar.json")
    target_dates = calendar[-EXPECTED_SESSIONS:]
    for basis in ("raw", "adjusted"):
        frame = pl.read_parquet(HERE / "daily-evidence" / f"legacy_{basis}.parquet")
        frame = frame.filter(pl.col("date").cast(pl.String).is_in(target_dates))
        assert frame.height == EXPECTED_STOCKS * EXPECTED_SESSIONS
        assert frame.select(pl.struct("code", "date").n_unique()).item() == frame.height
        valid = pl.all_horizontal(
            [
                *[pl.col(k).is_finite() & (pl.col(k) > 0) for k in ("open", "high", "low", "close")],
                pl.col("high") >= pl.max_horizontal("open", "close"),
                pl.col("low") <= pl.min_horizontal("open", "close"),
            ]
        )
        assert frame.select(valid.all()).item()
    confirmed = pl.read_parquet(HERE / "daily-evidence/confirmed_adjusted.parquet")
    assert confirmed["code"].n_unique() == EXPECTED_CONFIRMED
    assert str(confirmed["date"].max()) == "2026-10-23"
    coverage = read("daily-coverage.json")
    for stock in coverage["stocks"]:
        available = set(confirmed.filter(pl.col("code") == stock["code"])["date"].cast(pl.String))
        expected_missing = sorted(set(target_dates) - available)
        window = stock["coverage"]["confirmed"]["windows"]["target_125"]
        assert coverage["date_sets"][window["missing_or_invalid_dates_ref"]] == expected_missing
    worklist = read("confirmation-worklist.json")
    groups = worklist["confirm_history"], worklist["extend_existing_confirmation"]
    assert [g["count"] for g in groups] == [EXPECTED_STOCKS - EXPECTED_CONFIRMED, EXPECTED_CONFIRMED]
    listed = [x["code"] for g in groups for x in g["stocks"]]
    assert collections.Counter(listed) == collections.Counter(x["code"] for x in stocks)
    for href in re.findall(r"\]\(([^)]+)\)", (HERE / "README.md").read_text()):
        if not href.startswith("https://"):
            assert (HERE / href).exists(), href
    validation = {
        "checks": {
            name: "passed"
            for name in (
                "issuer_input_hashes",
                "all_38_code_quantity_and_cash_comparisons",
                "membership_union_and_master",
                "both_physical_files_477_by_125_unique_valid_ohlc",
                "confirmed_prices_and_all_missing_date_lists",
                "confirmation_worklist_partition",
                "report_local_links",
            )
        },
        "python": platform.python_version(),
        "polars": pl.__version__,
        "lint_result": lint,
        "read_semantics_match_local_main": True,
        "configuration_hashes": {name: sha(ROOT / name) for name in ("pyproject.toml", "uv.lock")},
        "head": command("git", "rev-parse", "HEAD"),
        "local_main": command("git", "rev-parse", "main"),
        "files": {
            str(f.relative_to(HERE)): sha(f)
            for f in sorted(HERE.rglob("*"))
            if f.is_file() and f.name != "validation.json" and "__pycache__" not in f.parts
        },
        "analysis_source_files": {
            name: sha(ROOT / "hoga/api" / name)
            for name in (
                "screener_series_values.py",
                "screener_series_store.py",
                "screener_daily_confirmation.py",
                "screener_daily_quality.py",
                "screener_corrections.py",
                "trading_days.py",
            )
        },
    }
    (HERE / "validation.json").write_text(json.dumps(validation, ensure_ascii=False, indent=2) + "\n")
    print("All evidence checks passed.")


if __name__ == "__main__":
    main()
