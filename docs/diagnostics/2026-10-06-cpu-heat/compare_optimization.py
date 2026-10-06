"""Read-only paired benchmark; writes only local report and temporary receipts.

Prepare the baseline with:
  git show 0c4491a284cd07c0f4645ac4d933094dbdcbde1c:hoga/tables/snapshots.py > /tmp/hoga-snapshots-before-cpu.py
Run from the repository root with PYTHONPATH=. and the worktree's Python.
Same-timestamp representative rows are compared as multisets; all displayed
peak fields and derived 3m/5m/60m/240m outputs are compared exactly.
"""
import cProfile
import dataclasses
import gc
import hashlib
import importlib.util
import json
import pstats
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import polars as pl

from hoga.api.past_indicators_cache import CACHE_MISS, PastIndicatorsCache
from hoga.api.peak_prewarm import _session_bounds
from hoga.api.queries import QueryEngine
from hoga.tables import snapshots

spec = importlib.util.spec_from_file_location("hoga.tables.snapshots_cpu_baseline", "/tmp/hoga-snapshots-before-cpu.py")
baseline = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = baseline
spec.loader.exec_module(baseline)
root = Path("/home/dev/.local/share/hoga-ops/data")
out = Path("docs/diagnostics/2026-10-06-cpu-heat/optimization-comparison.json")
cases = [("373220", "20260219"), ("267260", "20260219"), ("005490", "20260213")]
engine = QueryEngine(root)
engine.conn.execute("SET threads=4")
gc.set_threshold(50000, 50, 50)
rows = []


def digest(v):
    def norm(x):
        if dataclasses.is_dataclass(x):
            return dataclasses.asdict(x)
        if isinstance(x, (tuple, list)):
            return [norm(i) for i in x]
        if isinstance(x, dict):
            return {k: norm(i) for k, i in x.items()}
        return x

    return hashlib.sha256(json.dumps(norm(v), sort_keys=True, separators=(",", ":")).encode()).hexdigest()


try:
    for trial in range(4):
        for code, date in cases:
            bounds = _session_bounds(engine, date, code, "hogaplay", "KRX")
            p = engine.parquet_dir(date, code, "hogaplay", venue="KRX")
            hashes = []
            values = []
            intra = snapshots.hhmmssms_to_intra_ms_sql("ts_ms")
            where = snapshots._book_indicator_eligible_sql(intra, session_open_ms=bounds[0], session_close_ms=bounds[1])
            frames = baseline._read_peak_wall_frames(
                engine.conn,
                path=p / "snapshots.parquet",
                trades_path=p / "trades.parquet",
                bucket_ms=60000,
                where=where,
                intra=intra,
            )
            for name, mod in (
                [("before", baseline), ("after", snapshots)]
                if trial % 2 == 0
                else [("after", snapshots), ("before", baseline)]
            ):
                gc.collect()
                prof = cProfile.Profile()
                t = time.perf_counter()
                c = time.process_time()
                prof.enable()
                with patch.object(mod, "_read_peak_wall_frames", return_value=frames):
                    v = mod.query_day_ask_bid_peak_dual_with_rep(
                        engine.conn,
                        path=p / "snapshots.parquet",
                        trades_path=p / "trades.parquet",
                        bucket_ms=60000,
                        session_open_ms=bounds[0],
                        session_close_ms=bounds[1],
                    )
                prof.disable()
                cpu = time.process_time() - c
                wall = time.perf_counter() - t
                collects = sum(stats[1] for (_, _, fn), stats in pstats.Stats(prof).stats.items() if fn == "collect")
                h = digest(
                    (
                        v[0],
                        v[1],
                        sorted(v[2], key=lambda r: (r.side, r.bucket_id, r.intra_ms, r.seq, r.price, r.qty, r.touched)),
                    )
                )
                hashes.append(h)
                values.append(v)
                rows.append(
                    dict(
                        kind="peak_transform",
                        trial=trial,
                        code=code,
                        date=date,
                        variant=name,
                        wall_ms=wall * 1000,
                        cpu_ms=cpu * 1000,
                        collect_calls=collects,
                        sha256=h,
                    )
                )
            if hashes[0] != hashes[1]:
                for i in [0, 1]:
                    a, b = dataclasses.asdict(values[0][i]), dataclasses.asdict(values[1][i])
                    for k in a:
                        if a[k] != b[k]:
                            print("DIFF", trial, code, i, k, str(a[k])[:1500], str(b[k])[:1500], flush=True)
                raise RuntimeError("output mismatch")
            for side in ["ask", "bid"]:
                for bucket in [180000, 300000, 3600000, 14400000]:
                    derived = [
                        snapshots.reaggregate_peak_rep(
                            [r for r in v[2] if r.side == side], side=side, bucket_ms=bucket, date=date
                        )
                        for v in values
                    ]
                    assert digest(derived[0]) == digest(derived[1]), (code, date, side, bucket)
    with tempfile.TemporaryDirectory(prefix="hoga-receipts-") as tmp:
        for code, date in cases:
            cache = PastIndicatorsCache(root)
            original = cache._model_path

            def receipt_path(c, d, s, kind, original=original, **kw):
                return (
                    Path(tmp) / f"{c}-{d}-{kind}.json" if kind.startswith("prewarm.") else original(c, d, s, kind, **kw)
                )

            with patch.object(cache, "_model_path", side_effect=receipt_path):
                assert cache.has_prewarm_bundle(code, date, "hogaplay", 60000)
                for name in ["before", "after"]:
                    c = time.process_time()
                    t = time.perf_counter()
                    for _ in range(30):
                        # Cold in-memory cache each time, like an evicted historical entry.
                        fresh = PastIndicatorsCache(root)
                        orig_fresh = fresh._model_path

                        def fresh_path(c, d, s, kind, orig_fresh=orig_fresh, **kw):
                            return (
                                Path(tmp) / f"{c}-{d}-{kind}.json"
                                if kind.startswith("prewarm.")
                                else orig_fresh(c, d, s, kind, **kw)
                            )

                        with patch.object(fresh, "_model_path", side_effect=fresh_path):
                            ok = (
                                fresh.has_prewarm_bundle(code, date, "hogaplay", 60000)
                                if name == "after"
                                else fresh.has_ask_peak(code, date, "hogaplay", 60000)
                                and fresh.has_bid_peak(code, date, "hogaplay", 60000)
                                and fresh.get_depth(code, date, "hogaplay", 60000) is not CACHE_MISS
                            )
                            assert ok
                    rows.append(
                        dict(
                            kind="warm_check",
                            code=code,
                            date=date,
                            variant=name,
                            repeats=30,
                            wall_ms=(time.perf_counter() - t) * 1000,
                            cpu_ms=(time.process_time() - c) * 1000,
                        )
                    )
finally:
    engine.close()
result = dict(
    polars_threads=pl.thread_pool_size(),
    duckdb_threads=4,
    scope=("isolated read-only historical samples; identical Arrow frames for output equality; "
           "excludes SQL scans; interleaved variants; no laptop temperature claim"),
    measurements=rows,
)
out.write_text(json.dumps(result, indent=2))
for kind in ["peak_transform", "warm_check"]:
    for variant in ["before", "after"]:
        selected = [r for r in rows if r["kind"] == kind and r["variant"] == variant]
        print(
            kind,
            variant,
            {k: round(sum(r[k] for r in selected), 2) for k in ["wall_ms", "cpu_ms"]},
            "collects",
            sorted({r.get("collect_calls", 0) for r in selected}),
        )
