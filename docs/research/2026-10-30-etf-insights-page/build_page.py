"""Offline replay of the native /breadth page. No network or production writes.

Run from repository root: uv run python docs/research/2026-10-30-etf-insights-page/build_page.py
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path

import polars as pl

from hoga.market_breadth_insights import endpoint_changes, persistence, rolling_flags

HERE = Path(__file__).resolve().parent
RESEARCH = HERE.parent
ROOT = HERE.parents[2]
HISTORY = RESEARCH / "2026-10-30-etf-breadth-history"
ACTIVE = RESEARCH / "2026-10-30-etf-active-extension"
EXPECTED_POPULATION = 477
EXPECTED_READY_ETFS = 42
SCORE_TOLERANCE = 1e-10
OUTPUT = ROOT / "frontend/public/market-breadth/snapshot.json"
SOURCES = [
    HISTORY / n
    for n in (
        "summary.json",
        "calendar.json",
        "confirmed-history.parquet",
        "daily-panels.parquet",
        "benchmark-metrics.parquet",
    )
]
SOURCES += [ACTIVE / n for n in ("comparison-etfs.json", "etf-comparison-series.parquet")]
SOURCES += [RESEARCH / "2026-10-30-etf-breadth/stock-signals.json"]


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")


def load_flags(stocks, codes, all_dates):
    sessions = all_dates[-170:]
    prices = pl.read_parquet(HISTORY / "confirmed-history.parquet").filter(
        pl.col("code").is_in(codes) & (pl.col("date") >= dt.date.fromisoformat(sessions[0]))
    )
    values = {}
    for row in prices.iter_rows(named=True):
        key = (row["code"], row["date"].isoformat())
        assert key not in values
        values[key] = row["close"]
    flags = {c: rolling_flags([values.get((c, d)) for d in sessions]) for c in codes}
    for stock in stocks:
        assert flags[stock["code"]][-1] == tuple(stock["periods"][str(p)]["state"] == "above" for p in (20, 60, 120))
    return sessions, flags


def build():
    summary = read(HISTORY / "summary.json")
    all_dates = read(HISTORY / "calendar.json")
    dates = all_dates[-245:]
    as_of = summary["target"]
    assert dates[-1] == as_of
    funds = read(ACTIVE / "comparison-etfs.json")
    stocks = read(RESEARCH / "2026-10-30-etf-breadth/stock-signals.json")
    names = {s["code"]: s["name"] for s in stocks}
    codes = sorted(names)
    ready = [f for f in funds if f["calculation_status"] == "ready"]
    assert sorted({c for f in ready for c in f["codes"]}) == codes
    assert len(codes) == EXPECTED_POPULATION and len(ready) == EXPECTED_READY_ETFS
    sessions, flags = load_flags(stocks, codes, all_dates)
    endpoints = {}
    for horizon in (5, 20):
        current = endpoint_changes({c: flags[c][-1 - horizon] for c in codes}, {c: flags[c][-1] for c in codes})
        assert current is not None
        current.update({"from": sessions[-1 - horizon], "to": as_of})
        for row in current["stocks"]:
            row["name"] = names[row["code"]]
        timeline = []
        for i in range(119, len(sessions)):
            result = endpoint_changes({c: flags[c][i - horizon] for c in codes}, {c: flags[c][i] for c in codes})
            timeline.append(
                {
                    "date": sessions[i],
                    **(
                        {k: result[k] for k in ("improved", "declined", "unchanged")}
                        if result
                        else {"improved": None, "declined": None, "unchanged": None}
                    ),
                }
            )
        current["history"] = timeline
        endpoints[str(horizon)] = current
    panels = pl.read_parquet(HISTORY / "daily-panels.parquet")
    original = panels.filter(pl.col("panel") == "original_477").sort("date")
    baseline = {r["date"].isoformat(): r for r in original.iter_rows(named=True)}
    current = baseline[as_of]
    for h in (5, 20):
        assert (
            abs(endpoints[str(h)]["change"] - (current["full_score"] - baseline[all_dates[-1 - h]]["full_score"]))
            < SCORE_TOLERANCE
        )
    series = pl.read_parquet(ACTIVE / "etf-comparison-series.parquet").sort("etf_code", "date")
    series_by_code = {key[0]: frame for key, frame in series.partition_by("etf_code", as_dict=True).items()}
    exported = []
    for fund in funds:
        frame = series_by_code[fund["code"]]
        scores = frame["score"].to_list()
        assert len(scores) == len(all_dates)
        last = scores[-1]
        assert last == fund["current_score"] or abs(last - fund["current_score"]) < SCORE_TOLERANCE
        exported.append(
            {
                "code": fund["code"],
                "name": fund["name"],
                "style": fund["management_style"],
                "stockCount": fund["constituent_count"],
                "status": fund["calculation_status"],
                "score": last,
                "periods": fund["current_periods"],
                "d5": last - scores[-6] if last is not None and scores[-6] is not None else None,
                "d20": last - scores[-21] if last is not None and scores[-21] is not None else None,
                "persistence": persistence(scores),
                "line": scores[-245:],
                "validDays": fund["valid_score_days"],
                "firstDate": fund["first_calculable_date"],
                "issuerMatched": fund["issuer_original_composition_matched"],
                "pendingCount": len(fund["missing_price_codes"]),
                "youngCount": len(fund["short_listing_history_codes"]),
            }
        )
    benchmark_frame = pl.read_parquet(HISTORY / "benchmark-metrics.parquet")
    benchmarks = []
    for code, item in summary["benchmarks"].items():
        rows = {r["date"].isoformat(): r for r in benchmark_frame.filter(pl.col("code") == code).iter_rows(named=True)}
        benchmarks.append(
            {
                "code": code,
                "name": item["name"],
                "drawdown": [
                    rows[d]["drawdown252"] * 100 if rows[d]["drawdown252"] is not None else None for d in dates
                ],
                "volatility": [
                    rows[d]["realized_vol20"] * 100 if rows[d]["realized_vol20"] is not None else None for d in dates
                ],
            }
        )
    report = {
        "schemaVersion": 1,
        "asOf": as_of,
        "adjustedAsOf": summary["price_anchor"],
        "holdingsDate": funds[0]["constituent_reference_date"],
        "sourceSnapshot": summary["source_snapshot"],
        "dates": dates,
        "population": len(codes),
        "membershipRows": sum(f["constituent_count"] for f in ready),
        "baseline": {
            "score": current["full_score"],
            "d1": current["full_score"] - baseline[all_dates[-2]]["full_score"],
            "d5": endpoints["5"]["change"],
            "d20": endpoints["20"]["change"],
            "periods": [
                {"period": p, "above": current[f"above{p}"], "percent": current[f"breadth{p}"]} for p in (20, 60, 120)
            ],
            "line": [baseline[d]["full_score"] for d in dates],
            "periodLines": [
                [baseline[d][f"breadth{p}"] if baseline[d]["full_score"] is not None else None for d in dates]
                for p in (20, 60, 120)
            ],
            "allAbove": sum(all(flags[c][-1]) for c in codes),
            "noneAbove": sum(not any(flags[c][-1]) for c in codes),
        },
        "rarity": {
            "original": summary["panels"]["original_477"]["reference_position"],
            "cohort": summary["panels"]["fixed_complete_cohort"]["reference_position"],
            "cohortScore": summary["panels"]["fixed_complete_cohort"]["target_score"],
            "cohortSize": summary["cohort_size"],
        },
        "funds": exported,
        "benchmarks": benchmarks,
        "changes": endpoints,
    }
    save(OUTPUT, report)
    save(
        HERE / "validation.json",
        {
            "asOf": as_of,
            "population": len(codes),
            "readyEtfs": len(ready),
            "membershipRows": report["membershipRows"],
            "scoresAndCurrentFlagsMatched": True,
            "endpointChangesReconciled": True,
            "sources": {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in SOURCES},
            "output": str(OUTPUT.relative_to(ROOT)),
            "outputSha256": hashlib.sha256(OUTPUT.read_bytes()).hexdigest(),
        },
    )
    print(f"{OUTPUT.relative_to(ROOT)}: {OUTPUT.stat().st_size:,} bytes; {len(ready)} ETFs; {len(codes)} unique stocks")
    for h, data in endpoints.items():
        print(h, {k: data[k] for k in ("improved", "declined", "unchanged", "cancelling", "change")})


if __name__ == "__main__":
    build()
