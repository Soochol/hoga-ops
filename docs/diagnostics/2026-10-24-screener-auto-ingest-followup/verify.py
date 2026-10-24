"""Read-only integrity and preservation checks for the captured operational report."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent
REVIEWED_CODES = 86
SAVED_SEARCHES = 7
HTTP_CASES = 3


def read(name):
    return json.loads((ROOT / name).read_text())


def main():
    manifest = read("artifacts.json")
    for name, digest in manifest.items():
        assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
    review = read("review-86.json")
    assert len(review["rows"]) == REVIEWED_CODES
    assert review["counts"] == {
        "provider_empty_master_absent": 31,
        "sourced_delisting": 50,
        "pre_listing_dates": 3,
        "provider_empty_master_present": 2,
    }
    comparison = read("recorded-comparison.json")
    assert len(comparison["saved_searches"]) == SAVED_SEARCHES
    assert all(row["equal"] for row in comparison["saved_searches"])
    assert comparison["protected_unchanged"]
    http = read("http-after.json")
    assert http["old_archived_get_unchanged"]
    assert len(http["comparison"]) == HTTP_CASES and all(row["equal"] for row in http["comparison"])
    operation = read("operation.json")
    assert operation["completed"] and operation["processing_errors"] == 0
    assert operation["invalid_code_errors"] == 0
    assert all(operation["protected_unchanged"].values())
    assert operation["data_coverage_complete"] == (operation["summary"]["unavailable_codes"] == 0)
    print("PASS: artifacts, 86 classifications, saved searches, HTTP comparisons, completion and preservation")


if __name__ == "__main__":
    main()
