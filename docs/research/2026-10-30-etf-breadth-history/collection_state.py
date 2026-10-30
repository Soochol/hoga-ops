"""Audit real recovery jobs across a guarded, externally interrupted collection.

The original failed job remains failed. Completed observations can be reused
only when each target has exactly one confirmed result in the real job ledger.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from hoga.api import screener_recovery as recovery

HERE = Path(__file__).resolve().parent
DATA = Path.home() / ".local/share/hoga-ops/data"


def read(name):
    return json.loads((HERE / name).read_text())


def unchanged_plan_inputs(plan, original):
    if plan.baseline != original.baseline:
        raise ValueError("Collection baseline differs between plans")
    if plan.revision != original.revision:
        transitions = read("runtime-transitions.json")
        audited = [
            entry for entry in transitions
            if entry["from_revision"] == original.revision and entry["to_revision"] == plan.revision
        ]
        if len(audited) != 1:
            raise ValueError("Unaudited collector runtime transition")
        runtime_root = Path(recovery.__file__).resolve().parents[2]
        if any(
            hashlib.sha256((runtime_root / name).read_bytes()).hexdigest() != identity
            for name, identity in audited[0]["unchanged_capture_source_sha256"].items()
        ):
            raise ValueError("Audited unchanged capture source no longer matches")
    if plan.adjusted_as_of != original.adjusted_as_of or plan.calendar != original.calendar:
        raise ValueError("Collection basis or calendar differs between plans")
    if any(plan.protected[key] != value for key, value in original.protected.items() if key != "saves.json"):
        raise ValueError("A protected price or calculation input changed between plans")


def completed_collection():
    entries = read("collection-plans.json")
    plans = [recovery.load_plan(DATA, entry["plan_id"]) for entry in entries]
    jobs = [recovery.load_job(DATA, entry["plan_id"]) for entry in entries]
    original, latest = plans[0], plans[-1]
    if jobs[-1].status not in {"complete", "partial"} or not jobs[-1].preserved:
        raise ValueError("The latest collection must be stopped and preserved")
    items, origins = {}, {}
    for index, (entry, plan, job) in enumerate(zip(entries, plans, jobs, strict=True)):
        unchanged_plan_inputs(plan, original)
        expected_interruption = (
            (job.status == "failed" and job.error == "legacy_inputs_changed")
            or (job.status == "interrupted" and job.error == "owner_cancelled" and job.preserved)
        )
        if index < len(entries) - 1 and not expected_interruption:
            raise ValueError("Unexpected interrupted job; investigate instead of merging")
        if job.status == "collecting":
            raise ValueError("A collection is still running")
        for code, item in job.items.items():
            if item.status not in {"observed", "quarantined"}:
                continue
            if code in items or item.confirmation_state != "confirmed" or item.violations:
                raise ValueError(f"Duplicate, unconfirmed or invalid collected target: {code}")
            items[code], origins[code] = item, entry["plan_id"]
    if set(items) != {target.code for target in original.targets}:
        raise ValueError("Completed real jobs do not cover all original targets")
    if recovery.code_revision() != latest.revision:
        raise ValueError("Collector code/runtime changed")
    if recovery.protected_hashes(DATA) != latest.protected:
        raise ValueError("Protected inputs changed since the latest plan")
    return original, latest, items, origins, jobs
