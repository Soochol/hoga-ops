"""Offline audit of the actual review plan, 583 proofs, preserved inputs and operational comparisons."""

import gzip
import hashlib
import json
from fractions import Fraction
from pathlib import Path

from hoga.api import screener_corrections as corrections, screener_series_store as store
from hoga.api.models import ScreenerResponse
from hoga.api.screener_recovery_compare import _stable

HERE = Path(__file__).resolve().parent
NEW = 583
OLD = 483
TOTAL = 1066
REMAINING = 3154
EXECUTIONS = 9
SAVES = 7
HTTP_UNPROCESSABLE = 422
READY = {"000120", "003240", "013030", "900310"}


def read(name):
    path = HERE / name
    return json.loads(path.read_text() if path.exists() else gzip.decompress((HERE / (name + ".gz")).read_bytes()))


def proofs(plan_id, plan, result):
    source = read("proof-source-rows.json")
    rows = {(row["code"], row["date"]): row for row in source}
    assert len(rows) == len(source) == NEW
    bound = read("bound-review-input.json")
    assert store.digest(bound) == plan["review_binding"]["input_id"]
    payload = bound["payload"]
    evidence = {store.digest(value): value for value in payload["evidence"]}
    previous = read("previous-reviews.json")
    before = read("snapshot-before.json")["manifest"]
    after = read("snapshot-after.json")["manifest"]
    prior_dates = {(code, row["date"]) for code, review in previous.items() for row in review["accepted"]}
    assert len(prior_dates) == OLD
    selected = set()
    for code, review in previous.items():
        assert store.digest(review) == before["corrections"][code]
    for request in payload["requests"]:
        code = request["code"]
        review = result["reviews"][code]
        assert review["rejected"] == [] and review["review_plan_id"] == plan_id
        assert review["requested_proofs_id"] == store.digest(request)
        assert review["observation_id"] == before["observations"][code]
        assert review["previous_review"] == before.get("corrections", {}).get(code)
        assert store.digest(review) == after["corrections"][code]
        accepted = {row["date"]: row for row in review["accepted"]}
        for old in previous.get(code, {}).get("accepted", []):
            assert accepted[old["date"]] == old
        for entry in request["proofs"]:
            key = code, entry["date"]
            assert key not in selected and key not in prior_dates
            proof = corrections.CorrectionProof.model_validate(entry)
            row = rows[key]
            accepted_row = accepted[entry["date"]]
            assert all(accepted_row["preserved"][k] == row["old"][k] for k in corrections.FIELDS)
            assert all(accepted_row["selected"][k] == row["new"][k] for k in corrections.FIELDS)
            if proof.reason == "intraday_prefix":
                corrections._prefix(proof, evidence[proof.evidence_id], row["old"], row["new"])
            else:
                corrections._reverse(proof, evidence[proof.evidence_id], row["old"], row["new"],
                                     row["adjusted"], Fraction(str(row["legacy_factor"])))
            selected.add(key)
    assert len(selected) == NEW and selected == set(rows)
    assert sum(len(review["accepted"]) for review in result["reviews"].values()) == TOTAL


def verify_operational(plan):
    legacy = read("legacy-comparison.json")
    assert legacy["all_equal"] and len(legacy["results"]) == SAVES
    for row in legacy["results"]:
        assert row["equal"] and _stable(ScreenerResponse.model_validate(row["response"])) == _stable(
            ScreenerResponse.model_validate(row["after"]),
        )
    old, new = read("operational-before.json"), read("operational-after.json")
    records = old["results"] + new["results"]
    assert len(records) == EXECUTIONS
    for record in records:
        assert record["http_get_equal"] and record["exact_replay_equal"]
        assert record["code_revision"] == plan["revision"]
    old_raw = next(r for r in old["results"] if r["label"] == "diagnostic_1000")
    new_raw = next(r for r in new["results"] if r["label"] == "diagnostic_1000" and r["volume_basis"] == "raw")
    new_share = next(r for r in new["results"] if r["label"] == "diagnostic_1000"
                     and r["volume_basis"] == "share_adjusted")
    assert all(not target["complete"] for target in old_raw["targets"].values())
    assert all(target["complete"] and not target["matched"] for target in new_raw["targets"].values())
    assert all(not target["complete"] for target in new_share["targets"].values())
    witness = read("current-server-raw-witness.json")
    assert witness["same_semantic_result_as_validated_execution"] and set(witness["ready_codes"]) == READY
    drift = read("concurrent-primary-code-change.json")
    assert drift["online_replay_rejection"]["status_code"] == HTTP_UNPROCESSABLE
    assert drift["recorded_revision"] == plan["revision"]
    assert read("primary-install.json")["user_files_before"] == read("primary-install.json")["user_files_after"]


def main():
    manifest = HERE / "artifact-inputs.json"
    if manifest.exists():
        for name, checksum in json.loads(manifest.read_text()).items():
            assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == checksum, name
    plan_id = read("review-plan-id.json")["plan_id"]
    plan, result = read("review-plan.json"), read("apply-result.json")
    assert store.digest(plan) == plan_id
    assert plan["review_binding"]["parent_plan_id"] == read("source-job.json")["plan_id"]
    assert plan["review_binding"]["parent_job_id"] == store.digest({
        "kind": "screener_review_source_job", "job": read("source-job.json"),
    })
    assert result["new_selections"] == NEW and not result["already_applied"]
    assert read("retry-result.json")["already_applied"]
    assert read("retry-result.json")["snapshot_id"] == result["snapshot_id"]
    assert read("operational-job.json") == result["job"]
    items = result["job"]["items"]
    assert {code for code, item in items.items() if item["status"] == "observed"} == READY
    assert sum(len(item["conflict_dates"]) for item in items.values()) == REMAINING
    assert sum(len(item["resolved_conflict_dates"]) for item in items.values()) == TOTAL
    assert all(not item["original_missing"] and not item["price_missing"] for item in items.values())
    assert all(not item["share_evidence_ready"] for item in items.values())
    source_job = read("source-job.json")
    for code, item in items.items():
        assert item["candidate_id"] == source_job["items"][code]["candidate_id"]
        assert item["observation_id"] == source_job["items"][code]["observation_id"]
        assert item["added_original_days"] == source_job["items"][code]["added_original_days"]
    before, after = read("snapshot-before.json"), read("snapshot-after.json")
    assert store.digest(before["manifest"]) == before["id"] == plan["review_binding"]["snapshot_id"]
    assert store.digest(after["manifest"]) == after["id"] == result["snapshot_id"]
    assert after["manifest"]["parent"] == before["id"]
    for key, value in before["manifest"].items():
        if key not in {"parent", "corrections"}:
            assert after["manifest"][key] == value, key
    assert read("protected-before.json") == read("protected-after.json")
    preserved = read("final-preservation.json")
    assert preserved["legacy_files_preserved"] and preserved["source_plan_and_job_preserved"]
    assert preserved["previous_selections_preserved"] == OLD
    for name, checksum in read("source-files.json").items():
        assert hashlib.sha256((HERE / ("source-" + name + ".json")).read_bytes()).hexdigest() == checksum
    proofs(plan_id, plan, result)
    verify_operational(plan)
    print("PASS: 583 published in one v2 snapshot; previous 483 retained; 3154 remain quarantined.")
    print("PASS: 4 operational raw windows ready; saved legacy results 7/7 unchanged; 9 exact replays and HTTP GETs.")
    print("PASS: originals, saves, observation identities and source job preserved; idempotent retry confirmed.")
    print("PASS: concurrent primary code changes preserved; current server raw result verified separately.")


if __name__ == "__main__":
    main()
