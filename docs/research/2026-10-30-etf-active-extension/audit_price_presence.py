"""Read-only audit: general daily storage versus the frozen confirmed input.

Writes only the research report. No provider client or production mutation.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
STORE = Path.home() / ".local/share/hoga-ops/data/screener"


def identity(path):
    stat = path.stat()
    return stat.st_ino, stat.st_size, stat.st_mtime_ns


def main():
    targets = json.loads((HERE / "price-worklist.json").read_text())
    codes = [r["code"] for r in targets]
    calendar_path = HERE.parent / "2026-10-30-etf-breadth-history/calendar.json"
    calendar = [dt.date.fromisoformat(d) for d in json.loads(calendar_path.read_text())]
    recent = calendar[-125:]
    latest120 = set(calendar[-120:])
    names = ["stocks.parquet", "daily_unadjusted.parquet", "daily_adjusted.parquet"]
    before = {name: identity(STORE / name) for name in names}
    roster = pl.read_parquet(STORE / "stocks.parquet")
    report = {
        "audited_at": dt.datetime.now(dt.UTC).isoformat(),
        "target_count": len(codes),
        "in_general_daily_roster": roster.filter(pl.col("code").is_in(codes)).height,
        "price_target_date": calendar[-1].isoformat(),
        "recent_window_start": recent[0].isoformat(),
        "stores": {},
    }
    for name in names[1:]:
        query = pl.scan_parquet(STORE / name)
        total = query.select(pl.len().alias("rows"), pl.col("code").n_unique().alias("codes")).collect()
        selected = query.filter(pl.col("code").is_in(codes)).collect()
        details = []
        groups = {key[0]: value for key, value in selected.partition_by("code", as_dict=True).items()}
        for target in targets:
            code = target["code"]
            frame = groups.get(code)
            expected = {d for d in recent if d >= dt.date.fromisoformat(target["listing_date"])}
            dates = set(frame["date"]) if frame is not None else set()
            valid = (
                set(frame.filter(pl.col("close").is_finite() & (pl.col("close") > 0))["date"])
                if frame is not None
                else set()
            )
            details.append({
                "code": code,
                "rows": frame.height if frame is not None else 0,
                "first": min(dates) if dates else None,
                "last": max(dates) if dates else None,
                "recent_expected_since_listing": len(expected),
                "recent_missing_expected_dates": sorted(expected - dates),
                "has_latest_120_valid_closes": latest120 <= valid,
                "listing_history_lt120": len(expected) < len(latest120),
            })
        report["stores"][name] = {
            "total": total.row(0, named=True),
            "targets_present": sum(r["rows"] > 0 for r in details),
            "target_rows": sum(r["rows"] for r in details),
            "targets_latest_date": sum(r["last"] == calendar[-1] for r in details),
            "targets_recent_expected_complete": sum(not r["recent_missing_expected_dates"] for r in details),
            "targets_latest_120_valid_closes": sum(r["has_latest_120_valid_closes"] for r in details),
            "targets_short_listing_history": sum(r["listing_history_lt120"] for r in details),
            "details": details,
        }
    source = json.loads((HERE / "reused-price-observations.json").read_text())
    series = STORE / "series_v2"
    current = json.loads((series / "current.json").read_text())["id"]
    manifest = json.loads((series / "objects" / f"{current}.json").read_text())
    report["confirmed_snapshot"] = {
        "current_id": current,
        "matches_research_snapshot": current == source["source_snapshot"],
        "adjusted_as_of": manifest["adjusted_as_of"],
        "targets_in_observations": len(set(codes) & manifest["observations"].keys()),
    }
    report["source_files"] = {}
    for name in names:
        with (STORE / name).open("rb") as handle:
            checksum = hashlib.file_digest(handle, "sha256").hexdigest()
        assert identity(STORE / name) == before[name], f"Source changed during audit: {name}"
        report["source_files"][name] = {"identity": before[name], "sha256": checksum}
    report["script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    report["interpretation"] = (
        "415 means absent from the selected confirmed-adjusted research input, not absent from "
        "the collection roster or general daily storage. Existing daily presence does not itself "
        "certify a common adjustment anchor or historical provider confirmation. Audit and reuse "
        "existing evidence first; request only missing evidence or incompatible ranges."
    )
    (HERE / "price-presence-audit.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n"
    )
    print(json.dumps({
        "roster_present": report["in_general_daily_roster"],
        "stores": {name: {key: value for key, value in item.items() if key != "details"}
                   for name, item in report["stores"].items()},
        "confirmed_snapshot": report["confirmed_snapshot"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
