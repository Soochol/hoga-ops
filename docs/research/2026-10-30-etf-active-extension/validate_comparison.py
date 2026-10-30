"""Independent target-day arithmetic, frozen-input and full-output replay audit."""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
import subprocess
import sys
from collections import Counter
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
BASE = HERE.parent
PERIODS = (20, 60, 120)
EXPECTED_ACTIVE = 81
EXPECTED_BASE = 38
TOLERANCE = 1e-7
OUTPUTS = (
    "active-decisions.json",
    "memberships.json",
    "excluded-active-assets.json",
    "comparison-etfs.json",
    "expanded-stock-universe.json",
    "price-worklist.json",
    "etf-comparison-series.parquet",
    "summary.json",
)


def read(path):
    encoding = "utf-8"
    if path.is_relative_to(HERE / "raw"):
        captures = json.loads((HERE / "public-captures.json").read_text())
        encoding = captures.get(str(path.relative_to(HERE)), {}).get("encoding", encoding)
    return json.loads(path.read_bytes().decode(encoding))


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_target(funds, sessions, prices):
    window = sessions[-max(PERIODS) :]
    rows = prices.filter(pl.col("date").is_in(window))
    values = {code[0]: dict(part.select("date", "close").iter_rows()) for code, part in rows.group_by("code")}
    checks = []
    for fund in funds:
        percentages, ready_counts = {}, {}
        for period in PERIODS:
            ready, above = 0, 0
            for code in fund["codes"]:
                closes = [values.get(code, {}).get(day) for day in window[-period:]]
                if None in closes:
                    continue
                ready += 1
                above += closes[-1] > math.fsum(closes) / period
            ready_counts[period] = ready
            percentages[period] = 100 * above / len(fund["codes"]) if ready == len(fund["codes"]) else None
            actual = fund["current_periods"][str(period)]
            assert (actual is None and percentages[period] is None) or abs(actual - percentages[period]) < TOLERANCE
        expected = None if None in percentages.values() else math.fsum(percentages.values()) / len(PERIODS)
        actual = fund["current_score"]
        assert (actual is None and expected is None) or abs(actual - expected) < TOLERANCE
        assert fund["current_ready_count"] == ready_counts[max(PERIODS)]
        checks.append({"code": fund["code"], "score": actual, "ready120": ready_counts[max(PERIODS)]})
    return checks


def validate_sources():
    for name, record in read(HERE / "public-captures.json").items():
        assert digest(HERE / name) == record["sha256"]
    for code, record in read(HERE / "issuer-xls-captures.json").items():
        assert digest(HERE / "raw/issuer" / f"{code}.xls") == record["sha256"]
    old = {r["code"] for r in read(BASE / "2026-10-30-etf-universe/selected.json")}
    current = read(HERE / "raw/etf-list.json")["result"]["etfItemList"]
    prior = read(BASE / "2026-10-30-etf-universe/naver-etf-response.json")["result"]["etfItemList"]
    assert {r["itemcode"] for r in current} == {r["itemcode"] for r in prior}
    return old


def validate():
    original = validate_sources()
    funds = read(HERE / "comparison-etfs.json")
    assert len({f["code"] for f in funds}) == len(funds) == EXPECTED_BASE + EXPECTED_ACTIVE
    assert {f["code"] for f in funds if f["management_style"] == "passive"} == original
    assert sum(f["management_style"] == "active" for f in funds) == EXPECTED_ACTIVE
    assert all(f["constituent_count"] == len(set(f["codes"])) > 0 for f in funds)
    decisions = read(HERE / "active-decisions.json")
    assert len(decisions) == len(read(HERE / "active-discovery.json"))
    assert next(r for r in decisions if r["code"] == "0060H0")["decision"] == "excluded_foreign"
    assert next(r for r in decisions if r["code"] == "0199C0")["decision"] == "excluded_option_strategy"
    sessions = [dt.date.fromisoformat(s) for s in read(BASE / "2026-10-30-etf-breadth-history/calendar.json")]
    prices = pl.concat(
        [
            pl.read_parquet(BASE / "2026-10-30-etf-breadth-history/confirmed-history.parquet"),
            pl.read_parquet(HERE / "additional-confirmed-prices.parquet"),
        ]
    )
    assert prices.select(pl.struct("code", "date").n_unique()).item() == prices.height
    checks = validate_target(funds, sessions, prices)
    daily = pl.read_parquet(HERE / "etf-comparison-series.parquet")
    assert daily.height == len(funds) * len(sessions)
    size = pl.DataFrame({"etf_code": [f["code"] for f in funds], "denominator": [len(f["codes"]) for f in funds]})
    joined = daily.join(size, on="etf_code")
    insufficient = pl.any_horizontal(*[pl.col(f"ready{p}") < pl.col("denominator") for p in PERIODS])
    assert joined.filter(insufficient & pl.col("score").is_not_null()).is_empty()
    assert joined.filter((~insufficient) & pl.col("score").is_null()).is_empty()
    before = {name: digest(HERE / name) for name in OUTPUTS}
    replay = subprocess.run(
        [sys.executable, str(HERE / "build_comparison.py")], check=True, capture_output=True, text=True
    )
    (HERE / "replay-output.txt").write_text(replay.stdout)
    after = {name: digest(HERE / name) for name in OUTPUTS}
    assert before == after
    record = {
        "source_hashes_verified": True,
        "fresh_catalog_codes_match_original": True,
        "independent_target_day_scores": checks,
        "daily_mask_rows_verified": daily.height,
        "selected_style_counts": dict(Counter(f["management_style"] for f in funds)),
        "output_replay_hashes_identical": True,
        "output_sha256": after,
        "runtime": {"python": sys.version, "polars": pl.__version__},
        "source_script_sha256": {p.name: digest(p) for p in HERE.glob("*.py")},
    }
    (HERE / "validation.json").write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in record.items() if k != "independent_target_day_scores"}, indent=2))


if __name__ == "__main__":
    validate()
