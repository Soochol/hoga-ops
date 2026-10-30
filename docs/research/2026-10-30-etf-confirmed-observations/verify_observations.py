"""Audit an actual server-owned recovery without credentials or provider calls.

Run with the primary checkout's Python/PYTHONPATH so the server's resolver
semantics are used. Reads canonical immutable observations; writes only here.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
from fractions import Fraction
from pathlib import Path

import polars as pl

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_recovery as recovery,
    screener_series_store as store,
    screener_series_values as values,
)
from hoga.api.models import ScanRequest
from hoga.api.screener_series_runner import calendar_evaluate

HERE = Path(__file__).resolve().parent
DATA = Path.home() / ".local/share/hoga-ops/data"
LAST = dt.date(2026, 10, 29)
ANCHOR = "2026-10-30"
PERIODS = (20, 60, 120, 125)


def read(path):
    return json.loads(path.read_text())


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")


def load_context(pinned_snapshot=None):
    plan_id = read(HERE / "plan.json")["plan_id"]
    plan, job = recovery.load_plan(DATA, plan_id), recovery.load_job(DATA, plan_id)
    if job.status == "collecting":
        raise SystemExit("Recovery is still collecting. Final audit requires a stopped job.")
    universe = read(HERE.parent / "2026-10-30-etf-constituent-validation/universe.json")
    codes = [r["code"] for r in universe]
    names = {r["code"]: r["name"] for r in universe}
    snapshot_id, manifest = store.load_snapshot(DATA, pinned_snapshot)
    assert manifest["adjusted_as_of"] == ANCHOR
    days = [day for day in plan.calendar if day <= LAST][-max(PERIODS) :]
    assert len(days) == max(PERIODS) and days[-1] == LAST
    return plan_id, plan, job, codes, names, snapshot_id, manifest, days


def verify_existing_history(manifest):
    existing = read(HERE / "existing-coverage.json")
    before_manifest = read(HERE / "before-snapshot.json")["manifest"]
    before = values.load_series(
        DATA,
        before_manifest,
        [r["code"] for r in existing],
        first=min(dt.date.fromisoformat(r["first"]) for r in existing),
        last=LAST,
    )
    after = values.load_series(
        DATA,
        manifest,
        [r["code"] for r in existing],
        first=min(dt.date.fromisoformat(r["first"]) for r in existing),
        last=LAST,
    )
    report = []
    for row in existing:
        code = row["code"]
        missing = sorted(before[code].prices.keys() - after[code].prices.keys())
        assert not missing, (code, "previously confirmed adjusted history lost")
        lost_corrections = sorted(before[code].corrected - after[code].corrected)
        assert not lost_corrections, (code, "previously approved raw corrections lost")
        report.append(
            {
                "code": code,
                "in_requested_union": row["in_requested_union"],
                "previous_price_dates": len(before[code].prices),
                "new_price_dates": len(after[code].prices),
                "lost_price_dates": missing,
                "previous_corrected_dates": len(before[code].corrected),
                "new_corrected_dates": len(after[code].corrected),
                "lost_corrected_dates": lost_corrections,
            }
        )
    save("existing-history-preservation.json", report)


def verify_ma_consumer(snapshot_id, manifest, codes, resolved, days):
    requested = tuple(period for period in PERIODS if period != max(PERIODS))
    req = ScanRequest.model_validate(
        {
            "calculation_policy": "separate_bases_v2",
            "basis": "eod",
            "snapshot_id": snapshot_id,
            "conditions": [
                {
                    "id": f"ma{period}",
                    "type": "ma",
                    "params": {
                        "period": period,
                        "relation": "above",
                        "source": "close",
                        "timeframe": "D",
                        "include_open_bar": False,
                    },
                }
                for period in requested
            ],
        }
    )
    clock = dt.datetime.fromisoformat(read(HERE / "recovery-spec.json")["clock"])
    _, events, failures = calendar_evaluate(DATA, req, (snapshot_id, manifest), codes, clock)
    assert not failures, [(f.code, f.condition_id, f.reason) for f in failures]
    comparisons = []
    for period in requested:
        independent = set()
        for code in codes:
            window = days[-period:]
            closes = [Fraction(str(resolved[code].prices[day]["close"])) for day in window]
            if closes[-1] >= sum(closes) / period:
                independent.add(code)
        actual = {code for code, _ in events[f"ma{period}"]}
        assert actual == independent, (period, sorted(actual ^ independent))
        comparisons.append(
            {
                "period": period,
                "eligible": len(codes),
                "failure_count": 0,
                "engine_matches": len(actual),
                "independent_matches": len(independent),
                "code_sets_equal": True,
                "matching_codes": sorted(actual),
            }
        )
    save(
        "ma-verification.json",
        {"snapshot_id": snapshot_id, "evaluation_clock": clock, "target_close_date": LAST, "comparisons": comparisons},
    )


def verify(pinned_snapshot=None):
    plan_id, plan, job, codes, names, snapshot_id, manifest, days = load_context(pinned_snapshot)
    verify_existing_history(manifest)
    resolved = values.load_series(DATA, manifest, codes, first=days[0], last=LAST)
    verify_ma_consumer(snapshot_id, manifest, codes, resolved, days)
    protected = recovery.protected_hashes(DATA)
    assert protected == read(HERE / "protected-before.json"), "Protected legacy inputs changed"
    output, prices, raw_rows, candidate_rows, raw_differences = [], [], [], [], []
    before_id = read(HERE / "before-snapshot.json")["id"]
    before = store.load_snapshot(DATA, before_id)[1]
    baseline = pl.read_parquet(store.baseline_path(DATA, before, "daily_unadjusted.parquet"))
    baseline = baseline.filter(pl.col("code").is_in(codes), pl.col("date").is_between(days[0], LAST))
    baseline_by_key = {(r["code"], r["date"]): r for r in baseline.iter_rows(named=True)}
    for code in codes:
        item = job.items[code]
        observation_id = manifest["observations"].get(code)
        observation = store.read_object(DATA, observation_id)
        candidate = store.current_observation(DATA, observation)
        assert item.candidate_id is not None and item.observation_id == observation_id
        assert candidate["code"] == code and candidate["adjusted_as_of"] == ANCHOR
        state = confirmation.state(candidate)
        evidence = candidate["confirmation"]
        first, second = evidence["first"], evidence["second"]
        interval = (
            dt.datetime.fromisoformat(second["started_at"]) - dt.datetime.fromisoformat(first["finished_at"])
        ).total_seconds()
        assert interval >= confirmation.RECHECK_SECONDS
        assert store.digest({f: first[f] for f in confirmation.FIELDS}) == store.digest(
            {f: second[f] for f in confirmation.FIELDS}
        ), (code, "unstable independent observations")
        windows = {}
        for period in PERIODS:
            required = days[-period:]
            missing = [day for day in required if day not in resolved[code].prices]
            windows[str(period)] = {
                "required": period,
                "ready": not missing,
                "available": period - len(missing),
                "missing_dates": missing,
            }
        output.append(
            {
                "code": code,
                "name": names[code],
                "confirmation_state": state,
                "adjusted_as_of": candidate["adjusted_as_of"],
                "candidate_id": item.candidate_id,
                "observation_id": observation_id,
                "first_started_at": first["started_at"],
                "first_finished_at": first["finished_at"],
                "second_started_at": second["started_at"],
                "second_finished_at": second["finished_at"],
                "independent_interval_seconds": interval,
                "source": evidence["source"],
                "venue": evidence["venue"],
                "session_scope": evidence["session_scope"],
                "close_semantics": evidence["close_semantics"],
                "windows": windows,
                "recovery_status": item.status,
                "raw_conflict_dates": sorted(day for day in resolved[code].conflicts if days[0] <= day <= LAST),
                "violations": candidate["violations"],
                "share_evidence_ready": item.share_evidence_ready,
            }
        )
        for day, row in resolved[code].prices.items():
            prices.append({"code": code, "date": day, **{k: row[k] for k in ("open", "high", "low", "close")}})
        for row in candidate["unadjusted"]:
            day = dt.date.fromisoformat(row["date"])
            if days[0] <= day <= LAST:
                candidate_rows.append(
                    {"code": code, "date": day, **{k: row[k] for k in ("open", "high", "low", "close", "volume")}}
                )
                old = baseline_by_key.get((code, day))
                if old is not None:
                    changed = [k for k in ("open", "high", "low", "close", "volume") if old[k] != row[k]]
                    if changed:
                        raw_differences.append(
                            {"code": code, "date": day, "fields": changed, "legacy": old, "provider": row}
                        )
        for day, row in resolved[code].original.items():
            raw_rows.append(
                {"code": code, "date": day, **{k: row[k] for k in ("open", "high", "low", "close", "volume")}}
            )
    for name, rows in (
        ("confirmed-adjusted.parquet", prices),
        ("confirmed-raw-candidates.parquet", candidate_rows),
        ("resolved-raw.parquet", raw_rows),
    ):
        pl.DataFrame(rows).sort(["code", "date"]).write_parquet(HERE / name)
    summary = {
        "plan_id": plan_id,
        "snapshot_id": snapshot_id,
        "previous_snapshot_id": before_id,
        "requested_count": len(codes),
        "compatibility_count": len(plan.targets) - len(codes),
        "target_start": days[0],
        "target_end": LAST,
        "adjusted_as_of": ANCHOR,
        "confirmation_states": dict(collections.Counter(r["confirmation_state"] for r in output)),
        "ready_counts": {str(period): sum(r["windows"][str(period)]["ready"] for r in output) for period in PERIODS},
        "raw_conflict_stocks": sum(bool(r["raw_conflict_dates"]) for r in output),
        "raw_conflict_dates": sum(len(r["raw_conflict_dates"]) for r in output),
        "missing_price_stocks": [
            {"code": r["code"], "name": r["name"], "windows": r["windows"]}
            for r in output
            if not r["windows"]["125"]["ready"]
        ],
        "recovery_status": job.status,
        "protected_legacy_inputs_preserved": True,
        "minimum_recheck_interval_seconds": min(r["independent_interval_seconds"] for r in output),
        "resolver_code_revision": recovery.code_revision(),
    }
    save("stocks.json", output)
    save("summary.json", summary)
    save("job.json", job.model_dump(mode="json"))
    save("after-snapshot.json", {"id": snapshot_id, "manifest": manifest})
    save("protected-after.json", protected)
    save("raw-conflicts.json", raw_differences)
    save("output-hashes.json", {f.name: hashlib.sha256(f.read_bytes()).hexdigest() for f in HERE.glob("*.parquet")})
    print(json.dumps(summary, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--snapshot-id")
    verify(parser.parse_args().snapshot_id)
