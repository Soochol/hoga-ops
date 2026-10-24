"""Offline validation of recorded sources, correction proofs and result comparisons."""

import gzip
import hashlib
import json
from fractions import Fraction
from pathlib import Path

from hoga.api import screener_corrections as corrections, screener_series_store as store
from hoga.api.models import ScreenerResponse
from hoga.api.screener_recovery_compare import _stable

HERE = Path(__file__).resolve().parent
EXPECTED = {"targets": 25, "new_dates": 11172, "conflicts": 4220, "selected": 483, "remaining": 3737,
            "recheck_seconds": 2, "full_saved": 7, "comparisons": 10, "replays": 30, "protected_files": 8}


def read(name):
    path = HERE / name
    if path.exists():
        return json.loads(path.read_text())
    return json.loads(gzip.decompress((HERE / (name + ".gz")).read_bytes()))


def verify_proofs():
    reviews = read("correction-review.json")["reviews"]
    inputs = read("correction-input.json")
    evidence = {store.digest(item): item for item in inputs["evidence"]}
    audit = {(row["code"], row["date"]): row for row in read("proof-verification.json")["proofs"]}
    selected = []
    for code, review in reviews.items():
        assert review["rejected"] == []
        for item in review["accepted"]:
            proof = corrections.CorrectionProof.model_validate({
                key: item[key] for key in corrections.CorrectionProof.model_fields
            })
            source = evidence[proof.evidence_id]
            recorded = audit[code, item["date"]]
            assert recorded["evidence_id"] == proof.evidence_id
            if proof.reason == "intraday_prefix":
                corrections._prefix(proof, source, item["preserved"], item["selected"])
            else:
                corrections._reverse(
                    proof, source, item["preserved"], item["selected"],
                    {"volume": recorded["adjusted_volume"]}, Fraction(recorded["legacy_factor"]),
                )
            selected.append((code, item["date"]))
    assert len(selected) == len(set(selected)) == EXPECTED["selected"]


def verify_observations():
    before, after = read("job-before-review.json"), read("job-after-review.json")
    assert len(after["items"]) == EXPECTED["targets"]
    assert sum(item["added_original_days"] for item in after["items"].values()) == EXPECTED["new_dates"]
    assert sum(len(item["conflict_dates"]) for item in before["items"].values()) == EXPECTED["conflicts"]
    assert sum(len(item["conflict_dates"]) for item in after["items"].values()) == EXPECTED["remaining"]
    assert sum(len(item["resolved_conflict_dates"]) for item in after["items"].values()) == EXPECTED["selected"]
    assert all(not item["original_missing"] and not item["price_missing"] for item in after["items"].values())
    assert all(item["confirmation_state"] == "confirmed" for item in after["items"].values())
    assert all(item["status"] == "quarantined" and not item["share_evidence_ready"] for item in after["items"].values())
    inventory = read("observation-inventory.json")
    for code, value in inventory.items():
        assert value["first_values_digest"] == value["second_values_digest"]
        assert value["recheck_gap_seconds"] >= EXPECTED["recheck_seconds"]
        assert value["session_scope"] == "provider_daily_all_sessions"
        assert value["close_semantics"] == "provider_last_price"
        assert value["newly_added_required_dates"] == after["items"][code]["added_original_days"]
    conflicts = read("conflict-review.json")
    assert sum(len(value["differences"]) for value in conflicts.values()) == EXPECTED["conflicts"]
    assert sum(row["decision"] == "selected_in_v2" for value in conflicts.values()
               for row in value["differences"]) == EXPECTED["selected"]


def verify_results():
    scoped = read("comparison.json")
    assert scoped["production_preserved"] and len(scoped["results"]) == EXPECTED["comparisons"]
    replay_count = 0
    for result in scoped["results"]:
        before = ScreenerResponse.model_validate(result["legacy_before"])
        after = ScreenerResponse.model_validate(result["legacy_after"])
        assert result["legacy_equal"] and _stable(before) == _stable(after)
        assert set(result["variants"]) == {"raw", "share_adjusted", "raw_unreviewed"}
        for execution in result["executions"].values():
            assert execution["replay_equal"] and execution["execution_id"]
            replay_count += 1
    assert replay_count == EXPECTED["replays"]
    diagnostic = scoped["results"][-1]
    def codes(response):
        return {row["code"] for row in response["rows"]}
    assert "000020" not in codes(diagnostic["legacy_before"])
    assert "000020" not in codes(diagnostic["variants"]["raw_unreviewed"])
    assert "000020" in codes(diagnostic["variants"]["raw"])
    volume = scoped["results"][-3]["variants"]
    assert volume["raw"]["bar_coverage"]["complete"] == EXPECTED["targets"]
    assert volume["share_adjusted"]["bar_coverage"]["complete"] == 0
    reasons = {row["reason"] for row in volume["share_adjusted"]["bar_coverage"]["incomplete"]}
    assert reasons == {"share_evidence_unavailable"}
    wire = read("wire-execution-verification.json")
    assert wire["model_roundtrip_equal"] and wire["corrected_code_present"] == "000020"
    assert wire["calculation"]["daily_confirmation_policy"] == "historical_recheck_v1"
    assert wire["calculation"]["daily_session_scope"] == "provider_daily_all_sessions"
    assert wire["calculation"]["correction_revision"]
    full = read("full-universe-legacy-comparison.json")
    assert full["all_equal"] and len(full["results"]) == EXPECTED["full_saved"]
    for result in full["results"]:
        assert _stable(ScreenerResponse.model_validate(result["before"])) == _stable(
            ScreenerResponse.model_validate(result["after"])
        )


def main():
    for name, checksum in read("artifact-inputs.json").items():
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == checksum, name
    before, after = read("protected-before.json"), read("protected-after.json")
    assert before == after
    assert sum(value is not None for value in before.values()) == EXPECTED["protected_files"]
    assert read("tokens-before-collection.json") == read("tokens-after-collection.json")
    verify_proofs()
    verify_observations()
    verify_results()
    print("PASS: 25 confirmed observations, 11172 new dates, 483 proven selections, 3737 quarantined dates.")
    print("PASS: full saved conditions 7/7 and scoped legacy 10/10 unchanged; new exact replay checks 30/30.")
    print("PASS: original screener files, saved conditions and token fingerprints preserved.")


if __name__ == "__main__":
    main()
