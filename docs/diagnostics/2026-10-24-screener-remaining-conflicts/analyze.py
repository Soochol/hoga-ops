"""Reproduce the remaining-conflict review offline; never open or publish production data."""

from __future__ import annotations

import collections
import copy
import gzip
import hashlib
import json
from fractions import Fraction
from pathlib import Path

from hoga.api import screener_corrections as corrections, screener_series_store as store
from hoga.api.models import ScreenerResponse
from hoga.api.screener_recovery_compare import _stable

HERE = Path(__file__).resolve().parent
FIELDS = ("open", "high", "low", "close", "volume")
PRICES = FIELDS[:-1]
EXPECTED_TOTAL = 3737
EXPECTED_MINUTES = 417
EXPECTED_PREFIX = 212
EXPECTED_REVERSE = 371
EXPECTED_PROPOSALS = 583
EXPECTED_PENDING = 3154
EXPECTED_WINDOWS = 18
EXPECTED_FILINGS = 2793
BULK_END = {
    "020180": "2025-04-21", "038390": "2024-11-21", "044480": "2025-04-22",
    "900300": "2026-08-03", "020400": "2025-04-22", "001530": "2025-04-21",
    "003060": "2025-04-21", "012450": "2025-04-22", "900340": "2026-08-03",
}
PRE_EVENT = {
    "020180": (Fraction(1, 5), "2026-08-19"),
    "038390": (Fraction(2), "2024-11-22"),
}


def read(name):
    path = HERE / name
    if path.exists():
        return json.loads(path.read_text())
    return json.loads(gzip.decompress((HERE / (name + ".gz")).read_bytes()))


def inverse_identity(row, adjusted):
    """Exact legacy Python float operations, not an epsilon or quantity certification."""
    factor = row["legacy_factor"]
    return all(row["old"][key] == adjusted[key] / factor for key in PRICES) and (
        row["old"]["volume"] == round(adjusted["volume"] * factor)
    )


def verify_sources():
    sources = read("minute-collection.json")
    minute = read("minute-responses.json")
    assert len(sources) == len(minute) == EXPECTED_MINUTES
    for row in sources:
        assert row["error"] is None
        assert hashlib.sha256(minute[row["file"]].encode()).hexdigest() == row["sha256"]
        response = json.loads(minute[row["file"]])
        assert response["code"] == row["code"] and response["venue"] == "KRX"
        assert response["from"] == response["to"] == row["date"].replace("-", "")
        assert not response["data_warnings"]
    documents = read("primary-documents.json")
    for filing in read("kind-bodies.json"):
        assert not filing.get("error")
        for body in filing["bodies"]:
            assert not body.get("error")
            assert hashlib.sha256(documents[body["file"]].encode()).hexdigest() == body["sha256"]
    index = read("kind-index.json")
    assert len(index) == EXPECTED_WINDOWS
    assert sum(window["total"] for window in index) == EXPECTED_FILINGS
    for window in index:
        assert window["listing_search_complete"] and len(window["rows"]) == window["total"]
        assert len({row["id"] for row in window["rows"]}) == window["total"]
    ratio = read("organic-ratio-source.json")
    document = documents[ratio["file"]]
    assert "50:1" in document
    assert hashlib.sha256(document.encode()).hexdigest() == ratio["sha256"]


def verify_proofs(rows):
    payload = read("proposed-correction-input.json")
    evidence = {store.digest(item): item for item in payload["evidence"]}
    reverse = {(row["code"], row["date"]): row for row in read("reverse-proof-audit.json")}
    proofs = {}
    prefix_proofs = []
    for request in payload["requests"]:
        for entry in request["proofs"]:
            key = request["code"], entry["date"]
            assert key not in proofs
            proof = corrections.CorrectionProof.model_validate(entry)
            row, source = rows[key], evidence[proof.evidence_id]
            assert source["code"] == key[0]
            if proof.reason == "intraday_prefix":
                corrections._prefix(proof, source, row["old"], row["new"])
                prefix_proofs.append((proof, source, row))
            else:
                audit = reverse[key]
                assert audit["reason"] == proof.reason and audit["evidence_id"] == proof.evidence_id
                assert audit["legacy_factor"] == row["legacy_factor"]
                corrections._reverse(
                    proof, source, row["old"], row["new"], row["adjusted"], Fraction(str(row["legacy_factor"])),
                )
            proofs[key] = proof.reason
    assert len(proofs) == EXPECTED_PROPOSALS and len(prefix_proofs) == EXPECTED_PREFIX
    assert len(reverse) == EXPECTED_REVERSE
    # Negative control: one extra share in the recorded original must reject an otherwise valid prefix.
    proof, source, row = prefix_proofs[0]
    changed = copy.deepcopy(row["old"])
    changed["volume"] += 1
    try:
        corrections._prefix(proof, source, changed, row["new"])
    except ValueError as error:
        assert str(error) == "entire_ohlcv_prefix_does_not_match"
    else:
        raise AssertionError("One-share mutation was incorrectly accepted")
    return proofs


def classify(rows, proofs):
    classified = []
    minute = {(row["code"], row["date"]): row for row in read("minute-analysis.json")}
    for key, row in rows.items():
        code, day = key
        reason = proofs.get(key)
        if reason:
            category = reason
        elif code not in BULK_END or day > BULK_END[code]:
            assert not minute[key]["validated"] and minute[key]["rejection"] == "no_exact_entire_ohlcv_prefix"
            category = "daily_minute_scope_unresolved"
        elif code in PRE_EVENT:
            ratio, boundary = PRE_EVENT[code]
            assert day < boundary and row["legacy_factor"] == 1
            assert row["old"] == row["adjusted"]
            assert all(Fraction(str(row["old"][k])) == Fraction(str(row["new"][k])) / ratio for k in PRICES)
            assert row["old"]["volume"] == round(Fraction(row["new"]["volume"]) * ratio)
            category = "pre_event_adjusted_as_original_rule_required"
        elif code == "900300":
            assert inverse_identity(row, row["adjusted"])
            assert day < "2024-12-04"
            category = "multiple_consolidations_rule_required"
        elif code == "044480":
            # A derived old adjusted row alone cannot independently prove the original writer.
            assert inverse_identity(row, row["old_adjusted"])
            category = "historical_anchor_and_price_factor_unresolved"
        else:
            assert inverse_identity(row, row["adjusted"])
            category = "price_factor_inverse_reconstruction_rule_required"
        classified.append({"code": code, "date": day, "category": category,
                           "current_rule_candidate": reason is not None})
    assert set(minute) == {key for key in rows if key[0] not in BULK_END or key[1] > BULK_END[key[0]]}
    assert sum(row["validated"] for row in minute.values()) == EXPECTED_PREFIX
    return classified


def verify_simulation(proofs, rows):
    simulation = read("isolated-review.json")
    assert simulation["mode"] == "isolated_review_simulation_only"
    assert simulation["accepted_new"] == EXPECTED_PROPOSALS and simulation["rejected_new"] == 0
    assert simulation["remaining_conflicts"] == EXPECTED_PENDING
    assert simulation["legacy_hashes_equal"] and simulation["old_pinned_snapshot_unchanged"]
    assert simulation["full_raw_windows_without_conflict"] == ["000120", "003240", "013030", "900310"]
    records = read("isolated-review-records.json")
    for (code, day), reason in proofs.items():
        review = records[code]
        assert review["rejected"] == []
        assert review["baseline"] == simulation["baseline"]
        selected = next(row for row in review["accepted"] if row["date"] == day)
        assert selected["reason"] == reason
        original = rows[code, day]
        assert all(selected["preserved"][key] == original["old"][key] for key in FIELDS)
        assert all(selected["selected"][key] == original["new"][key] for key in FIELDS)
    comparison = read("simulation-comparison.json")
    assert comparison["legacy_equal"]
    assert _stable(ScreenerResponse.model_validate(comparison["legacy_before"])) == _stable(
        ScreenerResponse.model_validate(comparison["legacy_after"])
    )
    for value in comparison["executions"].values():
        assert value["replay_equal"] and value["execution_id"]
    responses = comparison["responses"]
    assert responses["raw_before"]["bar_coverage"]["complete"] == 0
    assert responses["raw_after"]["bar_coverage"]["complete"] == len(simulation["full_raw_windows_without_conflict"])
    assert responses["share_adjusted_after"]["bar_coverage"]["complete"] == 0
    assert all(not value["rows"] for value in responses.values())


def main():
    manifest = HERE / "artifact-inputs.json"
    if manifest.exists():
        for name, checksum in json.loads(manifest.read_text()).items():
            assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == checksum, name
    verify_sources()
    raw = read("rows.json")
    rows = {(row["code"], row["date"]): row for row in raw}
    assert len(rows) == len(raw) == EXPECTED_TOTAL
    targets = {row["code"]: row for row in read("target-windows.json")}
    for code, day in rows:
        assert targets[code]["first"] <= day <= targets[code]["last"]
    source = read("source.json")
    assert store.digest(source["manifest"]) == source["snapshot"] == source["current_snapshot"]
    inventory = read("observation-inventory.json")
    for code in targets:
        item = inventory[code]
        assert item["observation_id"] == source["manifest"]["observations"][code]
        assert item["confirmation"] == "confirmed"
        assert item["first_values_digest"] == item["second_values_digest"]
    assert read("protected-before.json") == read("protected-after.json")
    preserved = read("preservation.json")
    assert preserved["production_job_unchanged"] and preserved["production_additional_corrections"] == 0
    assert preserved["production_quantity_imports"] == 0 and preserved["legacy_hashes_unchanged"]
    assert preserved["v2_snapshot_unchanged"] == source["snapshot"]
    proofs = verify_proofs(rows)
    classified = classify(rows, proofs)
    verify_simulation(proofs, rows)
    counts = dict(collections.Counter(row["category"] for row in classified))
    assert counts == {
        "intraday_prefix": 212, "daily_minute_scope_unresolved": 205,
        "pre_event_adjusted_as_original_rule_required": 535,
        "historical_anchor_and_price_factor_unresolved": 318,
        "multiple_consolidations_rule_required": 226,
        "legacy_reverse_rounding": 347, "legacy_reverse_basis": 24,
        "price_factor_inverse_reconstruction_rule_required": 1870,
    }
    per_code = []
    stocks = {row["code"]: row["name"] for row in read("stocks.json")}
    for code, name in stocks.items():
        selected = [row for row in classified if row["code"] == code]
        candidates = sum(row["current_rule_candidate"] for row in selected)
        per_code.append({"code": code, "name": name, "conflicts": len(selected),
                         "current_rule_candidates": candidates, "remaining_if_applied": len(selected) - candidates,
                         "categories": dict(collections.Counter(row["category"] for row in selected))})
    summary = {
        "scope": "Frozen 25-stock requested windows; offline classification and isolated simulation only",
        "conflicts": len(rows), "current_rule_candidates": len(proofs), "pending_after_simulation": EXPECTED_PENDING,
        "production_additional_corrections": 0, "quantity_evidence_imports": 0,
        "categories": counts, "codes": per_code,
    }
    (HERE / "classification.json.gz").write_bytes(gzip.compress(
        json.dumps(classified,ensure_ascii=False,indent=2).encode(),mtime=0,
    ))
    (HERE / "summary.json").write_text(json.dumps(summary,ensure_ascii=False,indent=2))
    print("PASS: 3737 dates classified; 583 supported proposals, 3154 still pending in the simulation.")
    print("PASS: 417 minute sources, 2793 filing index entries, exact proof and negative-control checks.")
    print("PASS: isolated legacy result unchanged, 3 exact replays; no production publication.")


if __name__ == "__main__":
    main()
