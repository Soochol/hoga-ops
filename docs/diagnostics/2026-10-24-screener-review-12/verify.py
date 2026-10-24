"""Recheck frozen evidence only; no network, provider clients, production access or publication."""

import datetime as dt
import gzip
import hashlib
import json
from fractions import Fraction
from pathlib import Path

from hoga.api import screener_corrections as corrections, screener_series_store as store
from hoga.util.timeenc import KST

HERE = Path(__file__).resolve().parent
COUNTS = {"020180": 7, "038390": 5}
RESOLUTIONS = ("60000", "180000", "3600000")
FIELDS = corrections.FIELDS


def read(name):
    path = HERE / name
    return json.loads(path.read_bytes() if path.exists() else gzip.decompress((HERE / (name + ".gz")).read_bytes()))


def numbers(row):
    return {k: Fraction(str(row[k])) for k in FIELDS}


def basis_errors(record, event, anchor):
    rejected = {}
    for reason in ("legacy_reverse_rounding", "legacy_reverse_basis", "legacy_pre_event_adjusted_basis"):
        proof = corrections.CorrectionProof(date=record["date"], reason=reason, evidence_id=store.digest(event))
        try:
            corrections._basis_rule(proof, event, record["old"], record["selected"], record["adjusted"],
                                    Fraction(str(record["legacy_factor"])), anchor)
        except ValueError as exc:
            rejected[reason] = str(exc)
        else:
            raise AssertionError("Unexpected basis correction approval")
    expected = ({"legacy_reverse_rounding": "rounding_identity_not_proven",
                 "legacy_reverse_basis": "wrong_basis_outside_post_event_range",
                 "legacy_pre_event_adjusted_basis": "adjusted_basis_requires_unit_legacy_factor"}
                if record["code"] == "020180" else {
                    "legacy_reverse_rounding": "legacy_factor_does_not_match_evidence",
                    "legacy_reverse_basis": "legacy_factor_does_not_match_evidence",
                    "legacy_pre_event_adjusted_basis": "adjusted_basis_outside_pre_event_range",
                })
    assert rejected == expected
    return rejected


def analyze(records):
    rows = []
    events = {e["code"]: e for e in read("share-events.json")}
    anchor = read("snapshot-before.json")["manifest"]["adjusted_as_of"]
    for record in records:
        code, day = record["code"], record["date"]
        ymd = day.replace("-", "")
        old, new, adjusted = (numbers(record[k]) for k in ("old", "selected", "adjusted"))
        assert all(old[k] == new[k] for k in FIELDS if k != "volume")
        assert old["volume"] < new["volume"]
        for sample in record["historical_samples"].values():
            assert numbers(sample["unadjusted"]) == new and numbers(sample["adjusted"]) == adjusted
            raw = sample["raw_provider_row"]
            assert int(raw["trde_qty"]) == new["volume"] and raw["dt"] == ymd
        assert numbers(record["live_adjusted_daily"]) == adjusted
        aggregates = {}
        for resolution in RESOLUTIONS:
            response = record["minutes"][resolution]
            assert response["code"] == code and response["venue"] == "KRX" and not response["data_warnings"]
            bars = response["candles"]
            times = [bar["t_ms"] for bar in bars]
            assert times == sorted(set(times)) and times
            assert all(dt.datetime.fromtimestamp(t / 1000, KST).date().isoformat() == day for t in times)
            assert all(Fraction(str(bar["volume"])) >= 0 for bar in bars)
            factor = Fraction(str(response["adjust_factors"][ymd]))
            values = {
                "open": Fraction(str(bars[0]["open"])) / factor,
                "high": max(Fraction(str(b["high"])) for b in bars) / factor,
                "low": min(Fraction(str(b["low"])) for b in bars) / factor,
                "close": Fraction(str(bars[-1]["close"])) / factor,
                "volume": sum(Fraction(str(b["volume"])) for b in bars),
            }
            assert all(values[k] == old[k] for k in FIELDS if k != "volume")
            assert values["volume"] < old["volume"]
            aggregates[resolution] = int(values["volume"])
        assert len(set(aggregates.values())) == 1
        # Every prefix is <= total, which is strictly smaller than the legacy daily volume.
        source = {"kind": "provider_minute_prefix", "source": "kiwoom:ka10080", "code": code,
                  "response": record["minutes"]["60000"]}
        proof = corrections.CorrectionProof(date=day, reason="intraday_prefix", evidence_id=store.digest(source),
                                             prefix_end_ms=source["response"]["candles"][-1]["t_ms"])
        try:
            corrections._prefix(proof, source, record["old"], record["selected"])
        except ValueError as exc:
            assert str(exc) == "entire_ohlcv_prefix_does_not_match"
        else:
            raise AssertionError("Unexpected approval of an unexplained conflict")
        basis_rejections = basis_errors(record, events[code], anchor)
        portal = numbers(record["naver_chart"])
        assert all(portal[k] == adjusted[k] for k in FIELDS if k != "volume")
        if code == "038390":
            assert portal == new
            reverse_gap = None
        else:
            # Observed pattern only: this does not certify the portal's rounding or volume scope contract.
            assert portal["volume"] == int(new["volume"] / 5)
            reverse_gap = int(new["volume"] - portal["volume"] * 5)
        minute = aggregates["60000"]
        rows.append({"code": code, "date": day, "old_volume": int(old["volume"]),
                     "selected_volume": int(new["volume"]), "difference": int(new["volume"] - old["volume"]),
                     "minute_sum_all_three_resolutions": minute, "old_minus_minute": int(old["volume"] - minute),
                     "naver_volume": int(portal["volume"]), "naive_naver_times_five_shortfall": reverse_gap,
                     "prefix_evidence_id": proof.evidence_id, "basis_rule_rejections": basis_rejections,
                     "current_rule_eligible": False, "volume_scope_or_revision_cause_proven": False})
    assert {code: sum(r["code"] == code for r in records) for code in COUNTS} == COUNTS
    return rows


def main():
    for name, checksum in read("artifact-inputs.json").items():
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == checksum, name
    records = read("evidence.json")
    calculated = analyze(records)
    assert calculated == read("analysis.json")["rows"]
    live = read("live-responses.json")
    for item in read("live-collection.json") + read("one-minute-collection.json"):
        assert hashlib.sha256(live[item["file"]].encode()).hexdigest() == item["sha256"]
        assert not json.loads(live[item["file"]])["data_warnings"]
    for item in read("public-collection.json"):
        name = f"naver-{item['url'].split('symbol=')[1].split('&')[0]}.txt"
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == item["sha256"]
    before, preserved = read("snapshot-before.json"), read("preservation.json")
    assert store.digest(before["manifest"]) == before["id"]
    assert preserved["snapshot_unchanged"] and preserved["published_corrections"] == 0
    assert preserved["protected_before"] == preserved["protected_after"] == read("protected-before.json")
    assert preserved["job_files_before"] == preserved["job_files_after"] == read("jobs-before.json")
    preflight = read("current-rule-preflight.json")
    for result in preflight:
        assert result["requested"] == COUNTS[result["code"]] and result["new_accepted"] == 0
        assert len(result["rejected"]) == result["requested"]
        for rejection in result["rejected"]:
            row = next(r for r in calculated if r["code"] == result["code"] and r["date"] == rejection["date"])
            assert rejection["evidence_id"] == row["prefix_evidence_id"]
            assert rejection["error"] == "entire_ohlcv_prefix_does_not_match"
    job = read("source-job.json")
    assert {(c, d) for c in COUNTS for d in job["items"][c]["conflict_dates"]} == {
        (r["code"], r["date"]) for r in records
    }
    print("PASS: 12 volume-only conflicts; 1/3/60-minute totals agree and are below every legacy volume.")
    print("PASS: two historical raw observations and current adjusted daily agree; portal corroboration checked.")
    print("PASS: 0/12 eligible under current correction rules; no production corrections or saved-condition changes.")


if __name__ == "__main__":
    main()
