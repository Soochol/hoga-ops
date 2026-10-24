"""Read-only verification of this report and preserved primary-source bytes."""
import gzip
import hashlib
import json
from pathlib import Path

P = Path(__file__).parent
EXPECTED_CODES = 37
checks = json.loads((P / "artifacts-sha256.json").read_bytes())
for name, sha in checks.items():
    assert hashlib.sha256((P / name).read_bytes()).hexdigest() == sha, name
review = json.loads((P / "review.json").read_bytes())
assert len(review["records"]) == EXPECTED_CODES
for code, row in review["records"].items():
    bound = False
    for source in row["sources"]:
        raw = gzip.decompress((P / "sources" / (source["sha256"] + ".gz")).read_bytes())
        assert hashlib.sha256(raw).hexdigest() == source["sha256"], code
        bound |= code.encode() in raw
    assert bound, code
print("PASS: report hashes and all 37 code-bound primary-source proof sets")
