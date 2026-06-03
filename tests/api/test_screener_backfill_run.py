from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import run_backfill_with
from hoga.api.screener_factors import read_factors
from hoga.api.screener_store import DailyBar

_S = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def test_run_backfill_produces_factors_and_report(tmp_path: Path):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    un = pl.DataFrame([
        {"code": "035720", "date": dt.date(2021, 4, 5), "open": 502000.0, "high": 502000.0,
         "low": 502000.0, "close": 502000.0, "volume": 100},
        {"code": "035720", "date": dt.date(2021, 4, 15), "open": 120500.0, "high": 120500.0,
         "low": 120500.0, "close": 120500.0, "volume": 100},
    ], schema=_S)
    un.write_parquet(sdir / "daily_unadjusted.parquet")
    un.write_parquet(sdir / "daily_adjusted.parquet")  # old == unadjusted (heuristic miss)

    async def fetch_adj(code, frm, to):
        return [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)]

    async def fetch_raw(code, frm, to):
        return [DailyBar(code, dt.date(2021, 4, 5), 502000.0, 502000.0, 502000.0, 502000.0, 100),
                DailyBar(code, dt.date(2021, 4, 15), 120500.0, 120500.0, 120500.0, 120500.0, 100)]

    report = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))

    assert read_factors(sdir / "factors.parquet") is not None
    adj = pl.read_parquet(sdir / "daily_adjusted.parquet").filter(
        (pl.col("code") == "035720") & (pl.col("date") == dt.date(2021, 4, 5)))
    assert abs(adj["close"][0] - 100759.0) < 1.0  # now KIS-adjusted, not 502000
    assert report["impact"]["changed_codes"] >= 1


def test_rerun_preserves_prebackfill_baseline(tmp_path):
    sdir = tmp_path / "screener"; sdir.mkdir(parents=True)
    un = pl.DataFrame([
        {"code":"035720","date":dt.date(2021,4,5),"open":502000.0,"high":502000.0,"low":502000.0,"close":502000.0,"volume":100},
        {"code":"035720","date":dt.date(2021,4,15),"open":120500.0,"high":120500.0,"low":120500.0,"close":120500.0,"volume":100},
    ], schema=_S)
    un.write_parquet(sdir/"daily_unadjusted.parquet")
    un.write_parquet(sdir/"daily_adjusted.parquet")  # 휴리스틱 baseline(미보정)
    async def fetch_adj(code,frm,to): return [(dt.date(2021,4,5),100759.0),(dt.date(2021,4,15),120500.0)]
    async def fetch_raw(code,frm,to):
        return [DailyBar(code,dt.date(2021,4,5),502000.0,502000.0,502000.0,502000.0,100),
                DailyBar(code,dt.date(2021,4,15),120500.0,120500.0,120500.0,120500.0,100)]
    r1 = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))
    r2 = asyncio.run(run_backfill_with(sdir, fetch_adj=fetch_adj, fetch_raw=fetch_raw))  # 재실행
    assert r1["impact"]["changed_codes"] >= 1
    assert r2["impact"]["changed_codes"] >= 1   # 재실행에도 baseline 보존 → 여전히 변화 보고
    pb = pl.read_parquet(sdir/"daily_adjusted.prebackfill.parquet").filter(
        (pl.col("code")=="035720") & (pl.col("date")==dt.date(2021,4,5)))
    assert pb["close"][0] == 502000.0   # 원본(휴리스틱) 유지, KIS 값으로 안 덮임
