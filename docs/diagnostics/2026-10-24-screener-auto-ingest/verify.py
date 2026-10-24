"""Verify the frozen evidence; no broker calls, server writes or live data changes."""

import gzip
import hashlib
import json
from pathlib import Path

COUNTS = {"saves": 7, "replays": 4, "http": 3, "codes": 4404, "concurrency": 3, "present": 8, "absent": 3, "jobs": 9}
root = Path(__file__).resolve().parent
inputs = json.loads((root / "artifact-inputs.json").read_text())
for name, expected in inputs["files"].items():
    assert hashlib.sha256((root / name).read_bytes()).hexdigest() == expected, name
payload = json.loads(gzip.decompress((root / "evidence.json.gz").read_bytes()))
for identity, value in payload["objects"].items():
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode()
    assert hashlib.sha256(encoded).hexdigest() == identity, identity
legacy = payload["legacy-comparison.json"]
assert legacy["all_equal"] and len(legacy["comparisons"]) == COUNTS["saves"]
risk = payload["risk-comparison.json"]
assert risk["remaining_12_quarantined"] and risk["prior_535_approved_preserved"]
assert risk["original_prices_quantity_unchanged"]
assert len(risk["executions"]) == COUNTS["replays"] and all(r["replay_equal"] for r in risk["executions"])
http = payload["http-after.json"]
assert len(http["comparison"]) == COUNTS["http"] and all(r["equal"] for r in http["comparison"])
assert http["old_archived_get_unchanged"]
assert all(r["get_equal"] and r["exact_replay_equal"] for r in http["records"])
assert all(r["code_revision"] == inputs["code_revision"] for r in http["records"])
load = payload["load-results.json"]
assert load["code_revision"] == inputs["code_revision"]
assert load["all_historical_rows_equal"] and load["factors_and_saves_equal"]
assert all(
    r["codes"] == r["logical_requests"] == COUNTS["codes"] and r["max_concurrency"] <= COUNTS["concurrency"]
    for r in load["results"]
)
preserved = json.loads((root / "preservation.json").read_text())
assert preserved["protected_before"] == preserved["protected_after"]
assert (
    preserved["present_files_unchanged"] == COUNTS["present"]
    and preserved["absent_files_still_absent"] == COUNTS["absent"]
)
assert preserved["recovery_plans_and_jobs_unchanged"] == COUNTS["jobs"]
assert preserved["all_primary_feature_files_equal"]
print(
    "PASS: artifact hashes; saved scans7; quarantined12; preserved535; "
    "pinned replays4; HTTP comparisons3; 4404-Code load; protected data"
)
