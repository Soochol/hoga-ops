"""Verify frozen review evidence offline; no production writes or broker calls."""

import datetime as dt
import hashlib
import json
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
EPSILON = 1e-6
EXPECTED = {
    "protected_files": 8,
    "coloray_conflicts": 484,
    "rounding": 448,
    "rounding_limit": 2,
    "wrong_basis": 28,
    "total_conflicts": 618,
    "other_codes_conflicts": 134,
    "residual_dates": 142,
    "opening_volume": 9954,
    "recent_prefix_matches": 6,
    "aftermarket_closes": 7,
    "targets": 497,
    "missing": 290054,
    "collected": 6,
    "uncollected": 491,
    "added": 3096,
    "remaining": 286958,
    "suspect_codes": 43,
    "suspect_rows": 12689,
    "quantity_reviews": 8,
}


def read(name):
    return json.loads((HERE / name).read_text())


def aggregate(rows, factor=1.0):
    return {
        "open": rows[0]["open"] / factor,
        "high": max(row["high"] for row in rows) / factor,
        "low": min(row["low"] for row in rows) / factor,
        "close": rows[-1]["close"] / factor,
        "volume": sum(row["volume"] for row in rows),
    }


def equal(left, right):
    return all(abs(left[key] - right[key]) < EPSILON for key in left)


def verify_files():
    inputs = read("artifact-inputs.json")
    for name, expected in inputs.items():
        assert hashlib.sha256((HERE / name).read_bytes()).hexdigest() == expected, name

    protected = read("verification.json")
    assert protected["protected_before"] == protected["protected_after"]
    assert protected["protected_before"] == read("protected-before.json")
    assert sum(value is not None for value in protected["protected_before"].values()) == EXPECTED["protected_files"]



def verify_conflicts():
    pilot = json.loads((HERE.parent / "2026-10-24-screener-recovery-pilot/conflict-review.json").read_text())
    coloray = read("coloray-classification.json")
    assert sum(len(rows) for rows in coloray.values()) == pilot["900310"]["conflicts"] == EXPECTED["coloray_conflicts"]
    assert sorted((day for rows in coloray.values() for day in rows), key=lambda day: day["date"]) == sorted(
        pilot["900310"]["differences"], key=lambda day: day["date"]
    )
    assert len(coloray["reverse_rounding"]) == EXPECTED["rounding"]
    for row in coloray["reverse_rounding"]:
        volume = row["changes"]["volume"]
        assert volume["preserved"] == round(volume["observed"] / 5) * 5
        assert 0 < abs(volume["preserved"] - volume["observed"]) <= EXPECTED["rounding_limit"]
    assert len(coloray["wrong_basis_reverse"]) == EXPECTED["wrong_basis"]
    for row in coloray["wrong_basis_reverse"]:
        for field in ("open", "high", "low", "close"):
            values = row["changes"][field]
            assert abs(values["preserved"] * 5 - values["observed"]) < EPSILON
        volume = row["changes"]["volume"]
        assert volume["preserved"] == volume["observed"] * 5
    assert sum(item["conflicts"] for item in pilot.values()) == EXPECTED["total_conflicts"]
    other_conflicts = sum(item["conflicts"] for code, item in pilot.items() if code != "900310")
    assert other_conflicts == EXPECTED["other_codes_conflicts"]
    assert len(coloray["residual"]) + EXPECTED["other_codes_conflicts"] == EXPECTED["residual_dates"]



def verify_sessions():
    sessions = read("session-analysis.json")
    matched_codes, aftermarket_closes = [], 0
    for code, result in sessions.items():
        if code == "opening_snapshot":
            continue
        response = read(result["source_file"])
        day = result["date"].replace("-", "")
        factor = response["adjust_factors"][day]
        prefix = []
        matched = []
        for candle in response["candles"]:
            prefix.append(candle)
            if equal(aggregate(prefix, factor), result["preserved"]):
                timestamp = dt.datetime.fromtimestamp(candle["t_ms"] / 1000, ZoneInfo("Asia/Seoul"))
                matched.append(timestamp.strftime("%H:%M"))
        assert matched == [item["through"] for item in result["prefix_matching_entire_old_ohlcv"]]
        if matched:
            matched_codes.append(code)
        assert result["new_close_matches_final_minute"]
        assert abs(response["candles"][-1]["close"] / factor - result["observed"]["close"]) < EPSILON
        regular = result["regular_close_and_last"][0]["close_original_units"]
        aftermarket_closes += regular != result["observed"]["close"]
    opening = read("dongwha-june-one-minute.json")["candles"][:2]
    assert equal(aggregate(opening), sessions["opening_snapshot"]["aggregate"])
    assert aggregate(opening)["volume"] == EXPECTED["opening_volume"]
    assert len(matched_codes) == EXPECTED["recent_prefix_matches"]
    assert aftermarket_closes == EXPECTED["aftermarket_closes"]



def verify_expansion():
    targets = read("expansion-targets.json")
    audit = read("expansion-audit.json")
    assert len(targets) == len({row["code"] for row in targets}) == EXPECTED["targets"]
    assert sum(row["legacy_missing_days"] for row in targets) == EXPECTED["missing"]
    assert sum(row["pilot_observation"] is not None for row in targets) == EXPECTED["collected"]
    assert sum(row["pilot_observation"] is None for row in targets) == EXPECTED["uncollected"]
    assert audit["v2_added_required_code_dates"] == EXPECTED["added"]
    assert audit["remaining_missing_code_dates"] == EXPECTED["missing"] - EXPECTED["added"] == EXPECTED["remaining"]
    assert sum(row["fractional_original_price_rows"] > 0 for row in targets) == EXPECTED["suspect_codes"]
    assert sum(row["fractional_original_price_rows"] for row in targets) == EXPECTED["suspect_rows"]
    assert not any(row["automatic_approval"] for row in targets)
    quantities = read("quantity-history.json")
    assert len(quantities) == EXPECTED["quantity_reviews"]
    assert not any(row["runtime_share_evidence_published"] for row in quantities.values())



def main():
    verify_files()
    verify_conflicts()
    verify_sessions()
    verify_expansion()
    print("PASS: 618 conflicts; 448 rounding + 28 wrong basis + 142 residual dates.")
    print("PASS: 7 sampled daily OHLCV values reproduce minute prefixes; 7/8 recent closes differ from 15:30.")
    print("PASS: 497 targets, 491 uncollected, 286958 remaining date observations, 43 suspect codes.")
    print("PASS: frozen protected hashes equal; no production writes or network calls in this verification.")


if __name__ == "__main__":
    main()
