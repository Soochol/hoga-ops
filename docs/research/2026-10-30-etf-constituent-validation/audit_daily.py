"""Read-only capture and offline coverage audit for the selected ETF stock union.

Run at repository root with `uv run --extra dev python <this-file> --capture`
once. Subsequent runs without --capture use only the saved research evidence.
No app bootstrap, dotenv, broker calls, recovery, or production writes.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
TARGET = "2026-10-29"
PERIODS = (20, 60, 120, 125)


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")


def fingerprint(path):
    return hashlib.file_digest(path.open("rb"), "sha256").hexdigest()


def membership():
    selected = read(HERE.parent / "2026-10-30-etf-universe/selected.json")
    rows = []
    excluded = []
    for etf in selected:
        source = HERE.parent / "2026-10-30-etf-components-api/responses" / (etf["code"] + ".json")
        for row in read(source):
            item = {"etf_code": etf["code"], "group_id": etf["group_id"], "tier": etf["tier"], **row}
            (rows if row["componentItemCode"] else excluded).append(item)
    return selected, rows, excluded


def capture(data_dir: Path, master_path: Path):
    from hoga.api import (  # noqa: PLC0415 — capture-only read dependencies
        screener_series_store as store,
        screener_series_values as values,
        trading_days,
    )

    evidence = HERE / "daily-evidence"
    if evidence.exists():
        raise SystemExit("Evidence exists; refusing to overwrite. Use a fresh research directory.")
    _, members, _ = membership()
    codes = sorted({r["componentItemCode"] for r in members})
    calendar = sorted(d for d in trading_days.trading_days(data_dir) if d <= TARGET.replace("-", ""))
    assert calendar[-1] == TARGET.replace("-", "")
    calendar = [dt.datetime.strptime(d, "%Y%m%d").date() for d in calendar[-130:]]
    snapshot_id, manifest = store.load_snapshot(data_dir)
    files = {
        "security_master": master_path,
        "legacy_raw": data_dir / "screener/daily_unadjusted.parquet",
        "legacy_adjusted": data_dir / "screener/daily_adjusted.parquet",
        "calendar_seed": trading_days.SEED_PATH,
        "calendar_overlay": trading_days.overlay_path(data_dir),
    }
    before = {key: fingerprint(path) for key, path in files.items()}
    master = read(master_path)
    entries = [x for x in master["entries"] if x["code"] in codes]
    frames = {}
    for label, path in (("raw", files["legacy_raw"]), ("adjusted", files["legacy_adjusted"])):
        frames[label] = (
            pl.scan_parquet(path)
            .filter(pl.col("code").is_in(codes), pl.col("date").is_between(calendar[0], calendar[-1]))
            .collect()
            .sort(["code", "date"])
        )
    series = values.load_series(data_dir, manifest, codes, first=calendar[0], last=calendar[-1])
    prices = [
        {"code": code, "date": day, **{k: row[k] for k in ("open", "high", "low", "close")}}
        for code, item in series.items()
        for day, row in sorted(item.prices.items())
    ]
    after = {key: fingerprint(path) for key, path in files.items()}
    if before != after:
        raise SystemExit("Source changed during read. Nothing captured; retry with stable inputs.")
    evidence.mkdir()
    for label, frame in frames.items():
        frame.write_parquet(evidence / ("legacy_" + label + ".parquet"))
    pl.DataFrame(
        prices,
        schema={
            "code": pl.String,
            "date": pl.Date,
            "open": pl.Float64,
            "high": pl.Float64,
            "low": pl.Float64,
            "close": pl.Float64,
        },
    ).sort(["code", "date"]).write_parquet(evidence / "confirmed_adjusted.parquet")
    write(
        evidence / "security-master.json", {**{k: v for k, v in master.items() if k != "entries"}, "entries": entries}
    )
    write(evidence / "calendar.json", calendar)
    write(evidence / "series-manifest.json", {"snapshot_id": snapshot_id, "manifest": manifest})
    write(
        evidence / "series-diagnostics.json",
        {
            code: {
                "observation_id": manifest["observations"].get(code),
                "confirmed_adjusted_dates": sorted(item.prices),
                "raw_conflict_dates": sorted(item.conflicts),
                "daily_quality": {str(k): v for k, v in item.daily_quality.items()},
            }
            for code, item in series.items()
        },
    )
    write(
        evidence / "provenance.json",
        {
            "captured_at": dt.datetime.now(dt.UTC).isoformat(),
            "target": TARGET,
            "snapshot_id": snapshot_id,
            "files": {
                key: {"path": str(path), "sha256": before[key], "unchanged_during_read": True}
                for key, path in files.items()
            },
            "semantics": "screener_series_values.load_series; vendor-adjusted prices have independent confirmation",
            "snapshot_pointer_after_read": read(data_dir / "screener/series_v2/current.json"),
        },
    )


def audit():
    from hoga.api.screener_series_values import valid_price  # noqa: PLC0415

    evidence = HERE / "daily-evidence"
    selected, members, excluded = membership()
    master = {r["code"]: r for r in read(evidence / "security-master.json")["entries"]}
    universe = []
    for code in sorted({r["componentItemCode"] for r in members}):
        stock = master.get(code)
        assert stock and stock["security_type"] == "stock" and stock["market"] in {"KOSPI", "KOSDAQ"}
        rows = [r for r in members if r["componentItemCode"] == code]
        assert len({r["componentIsinCode"] for r in rows}) == 1
        assert rows[0]["componentIsinCode"][3:9] == code
        universe.append(
            {
                **stock,
                "isin": rows[0]["componentIsinCode"],
                "membership_count": len(rows),
                "etf_codes": [r["etf_code"] for r in rows],
                "groups": [r["group_id"] for r in rows],
                "constituent_reference_date": "2026-10-30",
            }
        )
    write(HERE / "universe.json", universe)
    write(HERE / "memberships.json", members)
    write(HERE / "excluded-assets.json", excluded)
    calendar = read(evidence / "calendar.json")
    manifest = read(evidence / "series-manifest.json")["manifest"]
    canonical_last = dt.datetime.strptime(manifest["calendar"][-1], "%Y%m%d").date().isoformat()
    dates = {"target": calendar, "snapshot": [d for d in calendar if d <= canonical_last]}
    frames = {
        name: pl.read_parquet(evidence / file)
        for name, file in {
            "raw": "legacy_raw.parquet",
            "adjusted": "legacy_adjusted.parquet",
            "confirmed": "confirmed_adjusted.parquet",
        }.items()
    }
    coverage = {}
    for name, frame in frames.items():
        by_code = collections.defaultdict(dict)
        for row in frame.iter_rows(named=True):
            by_code[row["code"]].setdefault(row["date"].isoformat(), []).append(row)
        coverage[name] = by_code
    result = []
    for stock in universe:
        code = stock["code"]
        item = {
            "code": code,
            "name": stock["name"],
            "market": stock["market"],
            "listing_date": stock.get("listing_date"),
            "etf_codes": stock["etf_codes"],
            "coverage": {},
        }
        for basis, by_code in coverage.items():
            rowmap = by_code[code]
            valid = {d for d, rows in rowmap.items() if len(rows) == 1 and valid_price(rows[0])}
            item["coverage"][basis] = {
                "first_saved_date_in_window": min(rowmap, default=None),
                "last_saved_date_in_window": max(rowmap, default=None),
                "duplicate_dates": [d for d, rows in rowmap.items() if len(rows) != 1],
                "invalid_ohlc_dates": [d for d, rows in rowmap.items() if any(not valid_price(r) for r in rows)],
                "zero_volume_dates": [d for d, rows in rowmap.items() if rows[0].get("volume") == 0],
                "windows": {},
            }
            for end, sessions in dates.items():
                for period in PERIODS:
                    expected = sessions[-period:]
                    assert len(expected) == period
                    missing = [d for d in expected if d not in valid]
                    item["coverage"][basis]["windows"][f"{end}_{period}"] = {
                        "end": expected[-1],
                        "start": expected[0],
                        "expected_count": period,
                        "valid_count": period - len(missing),
                        "missing_or_invalid_dates": missing,
                        "pre_listing_dates": [
                            d for d in missing if stock.get("listing_date") and d < stock["listing_date"]
                        ],
                        "complete": not missing,
                    }
        item["action"] = (
            "recover_physical_history_then_confirm"
            if not item["coverage"]["adjusted"]["windows"]["target_120"]["complete"]
            or not item["coverage"]["raw"]["windows"]["target_120"]["complete"]
            else "confirm_existing_history_and_align_adjusted_anchor"
        )
        result.append(item)
    # Share identical date lists so the 477-row worklist stays small and readable.
    date_sets = {}
    encoded = json.loads(json.dumps(result))
    for row in encoded:
        for basis in row["coverage"].values():
            for window in basis["windows"].values():
                for field in ("missing_or_invalid_dates", "pre_listing_dates"):
                    days = window.pop(field)
                    identity = hashlib.sha256(json.dumps(days).encode()).hexdigest()[:16]
                    assert identity not in date_sets or date_sets[identity] == days
                    date_sets[identity] = days
                    window[field + "_ref"] = identity
    write(HERE / "daily-coverage.json", {"schema_version": 1, "date_sets": date_sets, "stocks": encoded})
    summary = {
        "target": TARGET,
        "constituent_reference_date": "2026-10-30",
        "etfs": len(selected),
        "membership_rows": len(members),
        "unique_stocks": len(universe),
        "excluded_cash_rows": len(excluded),
        "markets": dict(collections.Counter(r["market"] for r in universe)),
        "snapshot_calendar_last": canonical_last,
        "snapshot_adjusted_as_of": manifest["adjusted_as_of"],
        "missing_snapshot_calendar_sessions": [d for d in calendar if d > canonical_last],
        "complete_counts": {
            basis: {
                key: sum(r["coverage"][basis]["windows"][key]["complete"] for r in result)
                for key in result[0]["coverage"][basis]["windows"]
            }
            for basis in coverage
        },
        "action_counts": dict(collections.Counter(r["action"] for r in result)),
        "physical_deficiencies": [
            {
                "code": r["code"],
                "name": r["name"],
                "raw_120_missing": r["coverage"]["raw"]["windows"]["target_120"]["missing_or_invalid_dates"],
                "adjusted_120_missing": r["coverage"]["adjusted"]["windows"]["target_120"]["missing_or_invalid_dates"],
            }
            for r in result
            if r["action"] == "recover_physical_history_then_confirm"
        ],
    }
    write(HERE / "summary.json", summary)
    existing = [r for r in result if r["coverage"]["confirmed"]["windows"]["snapshot_125"]["complete"]]
    unconfirmed = [r for r in result if r not in existing]
    evidence_window = dates["target"][-125:]
    write(
        HERE / "confirmation-worklist.json",
        {
            "target_close_date": TARGET,
            "constituent_reference_date": "2026-10-30",
            "preferred_history_sessions": 125,
            "reason_for_125": "MA120 plus a five-session comparison; MA120 alone needs 120 sessions",
            "start": evidence_window[0],
            "end": evidence_window[-1],
            "physical_backfill_required": [],
            "confirm_history": {
                "count": len(unconfirmed),
                "dates": evidence_window,
                "stocks": [{"code": r["code"], "name": r["name"], "etf_codes": r["etf_codes"]} for r in unconfirmed],
            },
            "extend_existing_confirmation": {
                "count": len(existing),
                "dates": summary["missing_snapshot_calendar_sessions"],
                "stocks": [{"code": r["code"], "name": r["name"], "etf_codes": r["etf_codes"]} for r in existing],
            },
            "shared_requirements": [
                "Extend the pinned calendar through the completed target session.",
                "Record one supplier-verified adjusted basis across all stocks, using the actual observation contract.",
                "Do not turn legacy file presence into supplier confirmation "
                "or reuse old-anchor prices by appending rows.",
                "Keep raw quantity disputes separate from independently confirmed adjusted-price evidence.",
                "Keep excluded or unresolved stocks visible in the breadth coverage denominator.",
            ],
        },
    )
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--capture", action="store_true")
    parser.add_argument("--data-dir", type=Path, default=Path.home() / ".local/share/hoga-ops/data")
    parser.add_argument("--master", type=Path, default=Path.home() / ".local/share/hoga-ops/symbol-master.json")
    args = parser.parse_args()
    if args.capture:
        capture(args.data_dir, args.master)
    audit()
