"""Re-fetch the public issuer URLs into a NEW research folder, without credentials.

This is an evidence collector, not a scheduled job. Some URLs return only the
latest basket; re-fetching later cannot recreate the 2026-10-30 snapshot.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import time
import urllib.request
from pathlib import Path


def fetch(output_dir: Path):
    source_dir = Path(__file__).resolve().parent
    specs = json.loads((source_dir / "issuer-source-manifest.json").read_text())
    # Validate all output paths and overwrite policy before the first request.
    if output_dir.exists():
        raise SystemExit("Output already exists. Choose a fresh evidence directory.")
    for spec in specs:
        if Path(spec["file"]).name != spec["file"] or not spec["url"].startswith("https://"):
            raise ValueError("Invalid evidence specification")
    output_dir.mkdir(parents=True)
    results = []
    for spec in specs:
        request = urllib.request.Request(spec["url"], headers={"User-Agent": "Mozilla/5.0"})
        record = {"code": spec["code"], "file": spec["file"], "url": spec["url"]}
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                record.update({"http_status": response.status, "final_url": response.url})
            record.update(
                {
                    "captured_at": dt.datetime.now(dt.UTC).isoformat(),
                    "raw_sha256": hashlib.sha256(raw).hexdigest(),
                    "raw_length": len(raw),
                }
            )
            if spec["kind"] == "kodex_product_projection":
                data = json.loads(raw)
                projected = {**record, "product": data["info"]["product"], "pdf": data["pdf"]}
                raw = (json.dumps(projected, ensure_ascii=False, indent=2) + "\n").encode()
            (output_dir / spec["file"]).write_bytes(raw)
            record["saved_sha256"] = hashlib.sha256(raw).hexdigest()
        except (OSError, json.JSONDecodeError, KeyError) as error:
            record["error"] = f"{type(error).__name__}: {error}"
        results.append(record)
        (output_dir / "fetch-results.json").write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n")
        print(spec["code"], spec["file"], record.get("http_status", record.get("error")), flush=True)
        time.sleep(0.5)
    if any("error" in record for record in results):
        raise SystemExit("Some issuer requests failed; see fetch-results.json. Do not publish as a complete snapshot.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    fetch(args.output_dir)
