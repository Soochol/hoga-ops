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

import polars as pl
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
base_classify = s._classify_wall_frame
base_record = s._peak_record_sequence
price = s._peak_price_distinct
touched = s._peak_touched_distinct
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
        for trial in range(4):
            names = ["baseline", "bucket_only", "shared_extrema", "shared_records"]
            if trial % 2:
                names.reverse()
            for name in names:
                holders = {}
                extremes = {}

                def record(df, *, touched_only=True, holders=holders):
                    key = id(df)
                    if key not in holders:
                        holders[key] = (df, df.sort(["intra_ms", "seq", "qty"], descending=[False, False, True]))
                    ordered = holders[key][1]
                    if touched_only and "touched" in ordered.columns:
                        ordered = ordered.filter(pl.col("touched"))
                    records = ordered.filter(pl.col("qty") > pl.col("qty").cum_max().shift(1, fill_value=-1))
                    if touched_only:
                        records = records.head(s._PEAK_RECORD_CAP)
                    return tuple(
                        s.AskPeakCandidateRow(price=p, qty=q, intra_ms=i)
                        for p, q, i in zip(records["price"], records["qty"], records["intra_ms"], strict=True)
                    )

                def classify(events, touches, *, side, extremes=extremes):
                    if not extremes:
                        both = touches.group_by("minute_id").agg(
                            pl.col("price").max().alias("ask"), pl.col("price").min().alias("bid")
                        )
                        for sd in ["ask", "bid"]:
                            extremes[sd] = pl.DataFrame({"minute_id": both["minute_id"], "_touch_extreme": both[sd]})
                    ev = events.sort(["ts_ms", "seq"])
                    if not ev.height:
                        return ev.with_columns(pl.lit(False).alias("touched"))
                    ev = ev.with_columns(pl.int_range(0, pl.len(), dtype=pl.Int64).alias("_ord"))
                    dominated = (
                        pl.col("_touch_extreme") >= pl.col("price")
                        if side == "ask"
                        else pl.col("_touch_extreme") <= pl.col("price")
                    )
                    return (
                        ev.join(extremes[side], on="minute_id", how="left")
                        .sort("_ord")
                        .with_columns(dominated.fill_null(False).alias("touched"))
                        .drop(["_ord", "_touch_extreme"])
                    )

                gc.collect()
                c = time.process_time()
                t = time.perf_counter()
                with (
                    patch.object(s, "_read_peak_wall_frames", return_value=frames),
                    patch.object(
                        s, "_peak_price_distinct", old._peak_price_distinct if name == "bucket_only" else price
                    ),
                    patch.object(
                        s, "_peak_touched_distinct", old._peak_touched_distinct if name == "bucket_only" else touched
                    ),
                    patch.object(s, "_classify_wall_frame", classify if name == "shared_extrema" else base_classify),
                    patch.object(s, "_peak_record_sequence", record if name == "shared_records" else base_record),
                ):
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
Path("docs/diagnostics/2026-10-07-peak-followup/prototypes.json").write_text(
    json.dumps(dict(measurements=rows, mismatches=mismatches), indent=2)
)
for name in names:
    a = [r for r in rows if r["variant"] == name]
    print(name, {k: sum(r[k] for r in a) for k in ["cpu_ms", "wall_ms"]})
print("mismatches", mismatches)
