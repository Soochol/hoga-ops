"""Read confirmed historical prices from a completed production recovery.

Uses the existing resolver, one fixed manifest, and its immutable baseline.
Writes research files only. No provider access, credentials, or publication.
"""

from __future__ import annotations

import json
from pathlib import Path

import polars as pl
from collection_state import completed_collection

from hoga.api import (
    screener_daily_confirmation as confirmation,
    screener_recovery as recovery,
    screener_series_store as store,
    screener_series_values as values,
)

HERE = Path(__file__).resolve().parent
DATA = Path.home() / ".local/share/hoga-ops/data"
CHUNK = 24


def read(name):
    return json.loads((HERE / name).read_text())


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2, default=str) + "\n")


def extract():
    plan, latest, items, origins, jobs = completed_collection()
    revisions = {pid: recovery.load_plan(DATA, pid).revision for pid in set(origins.values())}
    snapshot_id, manifest = store.load_snapshot(DATA)
    assert manifest["adjusted_as_of"] == plan.adjusted_as_of.isoformat()
    codes = [t.code for t in plan.targets]
    initial = read("before-snapshot.json")["manifest"]
    unrelated = {code: oid for code, oid in initial["observations"].items() if code not in codes}
    assert all(manifest["observations"].get(code) == oid for code, oid in unrelated.items())
    first, last = min(t.first for t in plan.targets), max(t.last for t in plan.targets)
    frames, ledger = [], []
    for offset in range(0, len(codes), CHUNK):
        chosen = codes[offset : offset + CHUNK]
        series = values.load_series(DATA, manifest, chosen, first=first, last=last)
        rows = []
        for code in chosen:
            oid = manifest["observations"][code]
            observation = store.current_observation(DATA, store.read_object(DATA, oid))
            assert confirmation.state(observation) == "confirmed", code
            assert observation["adjusted_as_of"] == plan.adjusted_as_of.isoformat()
            assert oid == items[code].observation_id
            dates = sorted(series[code].prices)
            ledger.append(
                {
                    "code": code,
                    "observation_id": oid,
                    "candidate_id": items[code].candidate_id,
                    "source_plan_id": origins[code],
                    "source_code_revision": revisions[origins[code]],
                    "confirmation_state": "confirmed",
                    "adjusted_as_of": observation["adjusted_as_of"],
                    "first_valid_price": dates[0] if dates else None,
                    "last_valid_price": dates[-1] if dates else None,
                    "valid_price_days": len(dates),
                    "violations": observation["violations"],
                    "first_received_at": observation["confirmation"]["first"]["started_at"],
                    "second_received_at": observation["confirmation"]["second"]["finished_at"],
                }
            )
            rows.extend(
                {"code": code, "date": day, **{k: row[k] for k in ("open", "high", "low", "close")}}
                for day, row in series[code].prices.items()
            )
        frames.append(pl.DataFrame(rows))
        print("extracted", min(offset + CHUNK, len(codes)), "/", len(codes), flush=True)
    frame = pl.concat(frames).sort(["code", "date"])
    assert frame.select(pl.struct("code", "date").n_unique()).item() == frame.height
    old = pl.read_parquet(HERE.parent / "2026-10-30-etf-confirmed-observations/confirmed-adjusted.parquet")
    comparison = old.join(frame, on=["code", "date"], how="left", suffix="_new")
    changed = comparison.filter(
        pl.any_horizontal(
            *[
                pl.col(k + "_new").is_null() | (pl.col(k) != pl.col(k + "_new"))
                for k in ("open", "high", "low", "close")
            ]
        )
    )
    save(
        "recent125-comparison.json",
        {"compared_rows": old.height, "changed_or_missing_rows": changed.height, "differences": changed.to_dicts()},
    )
    protected = recovery.protected_hashes(DATA)
    assert protected == latest.protected, "Protected legacy files changed since continuation"
    frame.write_parquet(HERE / "confirmed-history.parquet")
    save("calendar.json", [day for day in plan.calendar if first <= day <= last])
    save("source-observations.json", ledger)
    save("after-snapshot.json", {"id": snapshot_id, "manifest": manifest})
    save("jobs.json", [job.model_dump(mode="json") for job in jobs])
    save("protected-after.json", protected)
    save(
        "extraction-summary.json",
        {
            "source_plans": sorted(set(origins.values())),
            "source_runtime_revisions": revisions,
            "snapshot_id": snapshot_id,
            "codes": len(codes),
            "rows": frame.height,
            "first": first,
            "last": last,
            "adjusted_as_of": manifest["adjusted_as_of"],
            "recent125_changed_rows": changed.height,
            "unrelated_observation_ids_preserved": len(unrelated),
            "protected_files_preserved_since_latest_plan": True,
            "external_protected_changes_since_original": {
                key: {"before": value, "after": protected[key]}
                for key, value in plan.protected.items()
                if value != protected[key]
            },
        },
    )


if __name__ == "__main__":
    extract()
