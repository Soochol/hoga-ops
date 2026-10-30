"""Revalidate previously approved selections after a confirmed observation refresh.

Default is preflight only. --apply publishes one CAS batch only when every
accepted record is exactly unchanged and the original evidence passes again.
No new correction dates, selected values, or evidence are permitted here.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path

from collection_state import completed_collection

from hoga.api import screener_corrections as corrections, screener_recovery as recovery, screener_series_store as store

HERE = Path(__file__).resolve().parent
DATA = Path.home() / ".local/share/hoga-ops/data"


def load(name):
    return json.loads((HERE / name).read_text())


def save(name, value):
    (HERE / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def unchanged_selection(previous, refreshed):
    if refreshed["rejected"]:
        raise ValueError("Previous proof no longer validates; keep unresolved and investigate")
    if previous["accepted"] != refreshed["accepted"]:
        raise ValueError("Rebinding must not add, remove, or change any previously approved record")


def preserve(*, apply=False):
    with recovery.owner(DATA):
        original, plan, items, origins, _jobs = completed_collection()
        protected = plan.protected
        snapshot_id, manifest = store.load_snapshot(DATA)
        initial = load("before-snapshot.json")["manifest"]
        if manifest["baseline"] != initial["baseline"]:
            raise ValueError("Baseline changed")
        reviews, errors = {}, []
        for request_data in load("previous-approved-proof-requests.json"):
            code = request_data["code"]
            prior_id = request_data["previous_review"]
            if (
                manifest.get("corrections", {}).get(code) != prior_id
                or initial.get("corrections", {}).get(code) != prior_id
                or manifest["observations"][code] != items[code].observation_id
            ):
                raise ValueError("Observation or previous approved selection changed concurrently")
            request = corrections.CorrectionRequest.model_validate(
                {
                    "code": code,
                    "proofs": request_data["proofs"],
                }
            )
            review = corrections.prepare_review(DATA, request, manifest)
            previous = store.read_object(DATA, prior_id)
            try:
                unchanged_selection(previous, review)
            except ValueError as error:
                errors.append({"code": code, "error": str(error), "rejected": review["rejected"]})
            reviews[code] = review
            print(code, len(review["accepted"]), "accepted", len(review["rejected"]), "rejected", flush=True)
        save("review-preflight.json", {"snapshot_id": snapshot_id, "reviews": reviews, "errors": errors})
        if errors:
            raise SystemExit("Prior selection preservation failed; no correction batch was published")
        if (
            store.load_snapshot(DATA)[0] != snapshot_id
            or recovery.code_revision() != plan.revision
            or recovery.protected_hashes(DATA) != protected
        ):
            raise ValueError("Inputs changed during preflight")
        final_id = (
            store.publish_correction_reviews(DATA, reviews, expected_snapshot=snapshot_id) if apply else snapshot_id
        )
        final_manifest = store.read_object(DATA, final_id)
        if final_manifest["observations"] != manifest["observations"]:
            raise ValueError("Correction publication changed the price observations")
        untouched = {code: oid for code, oid in manifest.get("corrections", {}).items() if code not in reviews}
        if any(final_manifest.get("corrections", {}).get(code) != oid for code, oid in untouched.items()):
            raise ValueError("Unrelated approved correction review changed")
        save(
            "review-preservation.json",
            {
                "applied": apply,
                "starting_snapshot": snapshot_id,
                "final_snapshot": final_id,
                "review_codes": len(reviews),
                "unchanged_approved_records": sum(len(r["accepted"]) for r in reviews.values()),
                "new_correction_dates": 0,
                "changed_selected_records": 0,
                "unrelated_review_ids_preserved": len(untouched),
                "checked_at": dt.datetime.now(dt.UTC).isoformat(),
                "code_revision": plan.revision,
                "source_plans": sorted(set(origins.values())),
                "original_collection_failed_job_preserved_as_evidence": True,
            },
        )
        print("Previous selections preserved:", final_id, flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    preserve(apply=parser.parse_args().apply)
