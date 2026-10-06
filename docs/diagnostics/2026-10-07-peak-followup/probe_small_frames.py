"""Read-only prototype comparison on identical input frames.

Prepare original: git show 6fc7109c:hoga/tables/snapshots.py > /tmp/hoga-classifier-before.py
Run from repo root with PYTHONPATH=. .venv/bin/python <this-file>.
Baseline is the unrestricted three-helper pruning implementation (before follow-up).
Polars defaults are unchanged. DuckDB threads=4 applies only to this diagnostic.
Missing additional stock-dates are skipped; the report records measured cases.
"""

import dataclasses
import gc
import importlib.util
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pruning_baseline

from hoga.api.peak_prewarm import _session_bounds
from hoga.api.queries import QueryEngine, StockDateNotFound
from hoga.tables import snapshots as s

spec = importlib.util.spec_from_file_location("hoga.tables.preprune", "/tmp/hoga-classifier-before.py")
old = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = old
spec.loader.exec_module(old)
for helper in ["_peak_bucket_dedup", "_peak_price_distinct", "_peak_touched_distinct"]:
    setattr(s, helper, getattr(pruning_baseline, helper))

r = Path("/home/dev/.local/share/hoga-ops/data")
e = QueryEngine(r)
con = e.conn
con.execute("SET threads=4")
gc.set_threshold(50000, 50, 50)
rows = []
mismatches = []
cases = [
    ("373220", "20260219"),
    ("267260", "20260219"),
    ("005490", "20260213"),
    ("005930", "20260921"),
    ("000660", "20260921"),
    ("267260", "20260218"),
    ("005490", "20260212"),
]


def normal(v):
    return [dataclasses.asdict(x) if x is not None else None for x in v[:2]] + [[dataclasses.asdict(x) for x in v[2]]]


try:
    for code, date in cases:
        try:
            p = e.parquet_dir(date, code, "hogaplay", venue="KRX")
            b = _session_bounds(e, date, code, "hogaplay", "KRX")
        except (FileNotFoundError, ValueError, StockDateNotFound):
            continue
        if b is None:
            continue
        intra = s.hhmmssms_to_intra_ms_sql("ts_ms")
        frames = s._read_peak_wall_frames(
            con,
            path=p / "snapshots.parquet",
            trades_path=p / "trades.parquet",
            bucket_ms=60000,
            where=s._book_indicator_eligible_sql(intra, session_open_ms=b[0], session_close_ms=b[1]),
            intra=intra,
        )
        args = dict(
            path=p / "snapshots.parquet",
            trades_path=p / "trades.parquet",
            bucket_ms=60000,
            session_open_ms=b[0],
            session_close_ms=b[1],
        )
        reference = None
        for trial in range(8):
            names = ["baseline", "original", "small4096", "small16384"]
            if trial % 2:
                names.reverse()
            for name in names:

                def choose(fn, name=name):
                    prior = getattr(old, fn)
                    current = getattr(s, fn)
                    if name == "original":
                        return prior
                    threshold = 4096 if name == "small4096" else 16384 if name == "small16384" else 0
                    return lambda df: prior(df) if df.height < threshold else current(df)

                chosen = {
                    fn: choose(fn) for fn in ["_peak_bucket_dedup", "_peak_price_distinct", "_peak_touched_distinct"]
                }
                gc.collect()
                c = time.process_time()
                t = time.perf_counter()
                with patch.object(s, "_read_peak_wall_frames", return_value=frames), patch.multiple(s, **chosen):
                    v = s.query_day_ask_bid_peak_dual_with_rep(con, **args)
                rows.append(
                    dict(
                        code=code,
                        date=date,
                        trial=trial,
                        variant=name,
                        cpu_ms=(time.process_time() - c) * 1000,
                        wall_ms=(time.perf_counter() - t) * 1000,
                    )
                )
                result = normal(v)
                if reference is None:
                    reference = result
                if result != reference:
                    mismatches.append(dict(code=code, date=date, trial=trial, variant=name))
finally:
    e.close()
Path("docs/diagnostics/2026-10-07-peak-followup/small-frame-prototypes.json").write_text(
    json.dumps(dict(measurements=rows, mismatches=mismatches), indent=2)
)
for name in names:
    a = [r for r in rows if r["variant"] == name]
    print(name, {k: sum(r[k] for r in a) for k in ["cpu_ms", "wall_ms"]})
print("mismatches", mismatches)
