"""Compare candidate pruning with the merged PR #1925 baseline.

Prepare: git show 6fc7109c:hoga/tables/snapshots.py > /tmp/hoga-classifier-before.py
Run from repo root: PYTHONPATH=. .venv/bin/python <this-file> [--full]
Default verifies exact outputs on identical frames. --full times SQL as well;
existing nondeterministic input tie ordering is not an equivalence oracle.
Only the local report is written; source data and indicator caches are untouched.
"""

import argparse
import dataclasses
import gc
import importlib.util
import json
import sys
import time
from pathlib import Path
from unittest.mock import patch

from hoga.api.peak_prewarm import _session_bounds
from hoga.api.queries import QueryEngine
from hoga.tables import snapshots as s

parser = argparse.ArgumentParser()
parser.add_argument("--full", action="store_true")
options = parser.parse_args()

spec = importlib.util.spec_from_file_location("hoga.tables.classifier_baseline", "/tmp/hoga-classifier-before.py")
old = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = old
spec.loader.exec_module(old)
root = Path("/home/dev/.local/share/hoga-ops/data")
engine = QueryEngine(root)
con = engine.conn
con.execute("SET threads=4")
gc.set_threshold(50000, 50, 50)
rows = []
try:
    for code, date in [
        ("373220", "20260219"),
        ("267260", "20260219"),
        ("005490", "20260213"),
        ("005930", "20260921"),
        ("000660", "20260921"),
    ]:
        p = engine.parquet_dir(date, code, "hogaplay", venue="KRX")
        bounds = _session_bounds(engine, date, code, "hogaplay", "KRX")
        intra = s.hhmmssms_to_intra_ms_sql("ts_ms")
        frames = s._read_peak_wall_frames(
            con,
            path=p / "snapshots.parquet",
            trades_path=p / "trades.parquet",
            bucket_ms=60000,
            where=s._book_indicator_eligible_sql(intra, session_open_ms=bounds[0], session_close_ms=bounds[1]),
            intra=intra,
        )
        args = dict(
            path=p / "snapshots.parquet",
            trades_path=p / "trades.parquet",
            bucket_ms=60000,
            session_open_ms=bounds[0],
            session_close_ms=bounds[1],
        )
        for trial in range(6):
            values = []
            for name, mod in [("before", old), ("after", s)] if trial % 2 == 0 else [("after", s), ("before", old)]:
                gc.collect()
                t = time.perf_counter()
                c = time.process_time()
                if options.full:
                    v = mod.query_day_ask_bid_peak_dual_with_rep(con, **args)
                else:
                    with patch.object(mod, "_read_peak_wall_frames", return_value=frames):
                        v = mod.query_day_ask_bid_peak_dual_with_rep(con, **args)
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
                values.append(
                    [None if x is None else dataclasses.asdict(x) for x in v[:2]]
                    + [[dataclasses.asdict(x) for x in v[2]]]
                )
            if not options.full:
                assert values[0] == values[1], (code, trial)
finally:
    engine.close()
report_name = "full-query-confirmation.json" if options.full else "comparison.json"
(Path("docs/diagnostics/2026-10-07-peak-classifier") / report_name).write_text(
    json.dumps(
        {
            "scope": (
                "full query with SQL; equality checked separately"
                if options.full
                else "identical frames; peak fields and ordered representative rows equal; excludes SQL"
            ),
            "measurements": rows,
        },
        indent=2,
    )
)
for v in ["before", "after"]:
    rr = [r for r in rows if r["variant"] == v]
    print(v, {k: sum(r[k] for r in rr) for k in ["wall_ms", "cpu_ms"]})
