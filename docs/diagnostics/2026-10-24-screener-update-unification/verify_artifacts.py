"""Verify the preserved report files without contacting providers or changing data."""

import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).parent
for name, digest in json.loads((ROOT / "artifacts-sha256.json").read_bytes()).items():
    assert hashlib.sha256((ROOT / name).read_bytes()).hexdigest() == digest, name
print("PASS: all preserved report artifacts match their checksums")
