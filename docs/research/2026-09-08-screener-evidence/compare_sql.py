"""Read-only corpus comparison for the 250/250 saved screen; writes evidence locally.

Run from the repository with its Python dependencies:
    PYTHONPATH=. python docs/research/2026-09-08-screener-evidence/compare_sql.py

Reads HOGA_DATA_DIR / the normal local data directory. Temporary derived data is
removed automatically. 499 bars is specific to the bundled request, not a general
optimization for arbitrary conditions. Timings exclude preparation cost, reported
separately. This uses the local stock roster, not the running API's ETF master.
"""

import json
import tempfile
import time
from pathlib import Path

import polars as pl

from hoga.api.models import ScanRequest
from hoga.api.screener_scan import run_scan
from hoga.api.screener_universe import codes_for_universe
from hoga.config import resolve_data_dir

evidence = Path(__file__).resolve().parent
sdir = resolve_data_dir() / "screener"
req = ScanRequest.model_validate_json((evidence / "saved-eod-request.json").read_text())
original = sdir / "daily_adjusted.parquet"
codes = set(codes_for_universe(sdir / "stocks.parquet", req.universe))
records = []
baseline = None
with tempfile.TemporaryDirectory(prefix="hoga-screener-review-") as tmp:
    t = time.perf_counter()
    df = pl.read_parquet(original)
    trimmed = df.sort(["code", "date"]).group_by("code", maintain_order=True).tail(499)
    trimmed_path = Path(tmp) / "tail499.parquet"
    trimmed.write_parquet(trimmed_path)
    print(
        json.dumps(
            {
                "prepare_ms": round((time.perf_counter() - t) * 1000, 1),
                "full_rows": df.height,
                "tail_rows": trimmed.height,
                "eligible_codes": len(codes),
            }
        ),
        flush=True,
    )
    for label, path, scope in [
        ("full", original, None),
        ("early_universe", original, codes),
        ("tail499", trimmed_path, None),
        ("tail499_early_universe", trimmed_path, codes),
    ]:
        for n in range(3):
            t = time.perf_counter()
            rows = run_scan(
                path, sdir / "stocks.parquet", conditions=req.conditions, universe=req.universe, scope_codes=scope
            )
            elapsed = (time.perf_counter() - t) * 1000
            canonical = {r.code: r.model_dump() for r in rows}
            if baseline is None:
                baseline = canonical
            rec = {
                "case": label,
                "run": n + 1,
                "ms": round(elapsed, 1),
                "rows": len(rows),
                "same_values_and_membership": canonical == baseline,
            }
            records.append(rec)
            print(json.dumps(rec), flush=True)
(evidence / "sql-timings.json").write_text(json.dumps(records, indent=2))
