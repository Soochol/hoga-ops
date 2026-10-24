"""Read-only audit of 535 pre-event corrections and the recorded operational comparisons."""

import gzip
import hashlib
import json
from fractions import Fraction
from pathlib import Path

from hoga.api import screener_corrections as corrections, screener_series_store as store
from hoga.api.models import ScreenerResponse
from hoga.api.screener_recovery_compare import _stable

HERE = Path(__file__).resolve().parent
NEW, OLD, TOTAL, REMAINING = 535, 1066, 1601, 2619
SAVES, EXECUTIONS_PER_PHASE = 7, 6
TARGET_REMAINING = {"020180": 7, "038390": 5}
READY = {"000120", "003240", "013030", "900310"}


def read(name):
    path = HERE / name
    return json.loads(path.read_text() if path.exists() else gzip.decompress((HERE / (name + ".gz")).read_bytes()))


def verify_proofs(plan_id, plan, result):
    before, after = read("snapshot-before.json")["manifest"], read("snapshot-after.json")["manifest"]
    bound = read("bound-review-input.json")
    assert store.digest(bound) == plan["review_binding"]["input_id"]
    payload = bound["payload"]
    evidence = {store.digest(item): item for item in payload["evidence"]}
    rows = {(r["code"], r["date"]): r for r in read("proof-source-rows.json")}
    previous = read("previous-reviews.json")
    assert sum(len(r["accepted"]) for r in previous.values()) == OLD
    merged = {**previous, **result["reviews"]}
    assert sum(len(r["accepted"]) for r in merged.values()) == TOTAL
    assert set(merged) == set(after["corrections"])
    assert all(store.digest(review) == after["corrections"][code] for code, review in merged.items())
    for code, prior in previous.items():
        assert store.digest(prior) == before["corrections"][code]
        accepted = {r["date"]: r for r in merged[code]["accepted"]}
        assert all(accepted[r["date"]] == r for r in prior["accepted"])
    wanted = set()
    for request in payload["requests"]:
        code = request["code"]
        review = result["reviews"][code]
        assert not review["rejected"] and review["review_plan_id"] == plan_id
        assert review["requested_proofs_id"] == store.digest(request)
        assert review["observation_id"] == before["observations"][code]
        assert review["previous_review"] == before["corrections"].get(code)
        assert store.digest(review) == after["corrections"][code]
        accepted = {r["date"]: r for r in review["accepted"]}
        for entry in request["proofs"]:
            key = code, entry["date"]
            assert key not in wanted
            wanted.add(key)
            proof = corrections.CorrectionProof.model_validate(entry)
            assert proof.reason == "legacy_pre_event_adjusted_basis"
            row = rows[key]
            assert all(accepted[entry["date"]]["preserved"][k] == row["old"][k] for k in corrections.FIELDS)
            assert all(accepted[entry["date"]]["selected"][k] == row["new"][k] for k in corrections.FIELDS)
            corrections._pre_event_adjusted(
                proof, evidence[proof.evidence_id], row["old"], row["new"], row["adjusted"],
                Fraction(str(row["legacy_factor"])), plan["adjusted_as_of"],
            )
    assert wanted == set(rows) and len(wanted) == NEW
    assert {code: sum(c == code for c, _ in wanted) for code in ("020180", "038390")} == {
        "020180": 317, "038390": 218,
    }
    series = read("series-comparison.json")["rows"]
    assert {(r["code"], r["date"]) for r in series} == wanted
    assert all(r["before_conflict"] and not r["after_conflict"] and r["adjusted_unchanged"]
               and r["share_adjusted_volume"] is None for r in series)


def verify_operational(plan):
    legacy = read("legacy-comparison.json")
    assert legacy["all_equal"] and len(legacy["results"]) == SAVES
    for row in legacy["results"]:
        assert row["equal"] and _stable(ScreenerResponse.model_validate(row["response"])) == _stable(
            ScreenerResponse.model_validate(row["after"]),
        )
    old, new = read("operational-before.json"), read("operational-after.json")
    assert len(old["results"]) == len(new["results"]) == EXECUTIONS_PER_PHASE
    for record in old["results"] + new["results"]:
        assert record["http_get_equal"] and record["exact_http_replay_equal"]
        assert record["response"] == ScreenerResponse.model_validate(record["response"]).model_dump(mode="json")
    assert all(r["code_revision"] == plan["revision"] for r in new["results"])
    previous = {r["label"]: r for r in old["results"]}
    current = {r["label"]: r for r in new["results"]}
    for label in ("historical_amount", "historical_volume_raw"):
        assert all(not t["complete"] for t in previous[label]["targets"].values())
        assert all(t["complete"] and t["matched"] for t in current[label]["targets"].values())
    assert all(not t["complete"] for t in current["historical_volume_share"]["targets"].values())
    assert all(not t["complete"] for t in current["diagnostic_1000_raw"]["targets"].values())
    assert read("operational-comparison.json")["long_window_ready_codes"] == sorted(READY)


def main():
    for name, checksum in read("artifact-inputs.json").items():
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == checksum, name
    identity = read("review-plan-id.json")["plan_id"]
    plan, result = read("review-plan.json"), read("apply-result.json")
    assert store.digest(plan) == identity
    assert plan["review_binding"]["parent_plan_id"] == read("source-job.json")["plan_id"]
    assert plan["review_binding"]["parent_job_id"] == store.digest({
        "kind": "screener_review_source_job", "job": read("source-job.json"),
    })
    assert result["new_selections"] == NEW and not result["already_applied"]
    assert read("retry-result.json")["already_applied"]
    assert read("retry-result.json")["snapshot_id"] == result["snapshot_id"]
    assert read("operational-job.json") == result["job"]
    items = result["job"]["items"]
    assert {c for c, item in items.items() if item["status"] == "observed"} == READY
    assert sum(len(item["conflict_dates"]) for item in items.values()) == REMAINING
    assert sum(len(item["resolved_conflict_dates"]) for item in items.values()) == TOTAL
    assert all(len(items[code]["conflict_dates"]) == count for code, count in TARGET_REMAINING.items())
    assert all(not item["share_evidence_ready"] for item in items.values())
    for code, item in items.items():
        source = read("source-job.json")["items"][code]
        assert all(item[k] == source[k] for k in ("candidate_id", "observation_id", "added_original_days"))
    before, after = read("snapshot-before.json"), read("snapshot-after.json")
    assert store.digest(before["manifest"]) == before["id"] == plan["review_binding"]["snapshot_id"]
    assert store.digest(after["manifest"]) == after["id"] == result["snapshot_id"]
    assert after["manifest"]["parent"] == before["id"]
    for key, value in before["manifest"].items():
        if key not in {"parent", "corrections"}:
            assert after["manifest"][key] == value, key
    assert read("protected-before.json") == read("protected-after.json")
    for name, checksum in read("source-files.json").items():
        assert hashlib.sha256((HERE / ("source-" + name + ".json")).read_bytes()).hexdigest() == checksum
    verify_proofs(identity, plan, result)
    verify_operational(plan)
    print("PASS: 535 exact pre-event corrections; previous 1066 retained; 1601 total, 2619 conflicts remain.")
    print("PASS: legacy saves 7/7 unchanged; 12 actual HTTP executions and version-bound exact replays.")
    print("PASS: 535 raw selections verified; two historical windows ready; quantity history remains unknown.")


if __name__ == "__main__":
    main()
