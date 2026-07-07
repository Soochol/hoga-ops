from __future__ import annotations

import asyncio
import datetime as dt
from types import SimpleNamespace
from pathlib import Path

import polars as pl

from hoga.api import screener_backfill as screener_backfill_mod
from hoga.live.kis_client import KIS_KST
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


async def test_run_backfill_fetches_daily_rows_through_capacity_scheduler(tmp_path, monkeypatch):
    scheduler = object()
    calls = []
    t_ms = int(dt.datetime(2026, 6, 1, tzinfo=KIS_KST).timestamp() * 1000)

    class FakeKis:
        async def fetch_past_daily_candles(self, code, frm, to, *, adjust):
            calls.append(("client", code, frm, to, adjust))
            return SimpleNamespace(candles=[
                SimpleNamespace(
                    t_ms=t_ms,
                    open=1.0,
                    high=2.0,
                    low=1.0,
                    close=3.0 if adjust else 2.0,
                    volume=10,
                )
            ])

    async def fake_run_with_capacity(
        scheduler_arg,
        *,
        data_dir,
        key,
        endpoint,
        priority,
        fetch_fn,
        cooldown_scope=None,
    ):
        calls.append({
            "scheduler": scheduler_arg,
            "data_dir": data_dir,
            "key": key,
            "endpoint": str(endpoint),
            "priority": priority,
            "cooldown_scope": cooldown_scope,
        })
        return await fetch_fn(FakeKis())

    async def fake_run_backfill_with(sdir, *, fetch_adj, fetch_raw, now_ms=None):
        adj = await fetch_adj("005930", "20260601", "20260601")
        raw = await fetch_raw("005930", "20260601", "20260601")
        return {"adj": adj, "raw": raw, "sdir": sdir}

    monkeypatch.setattr(
        "hoga.live.kis_access.has_rest_capacity",
        lambda data_dir: True,
    )
    monkeypatch.setattr(
        "hoga.live.kis_capacity_runtime.ensure_kis_capacity_scheduler",
        lambda data_dir: scheduler,
    )
    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(screener_backfill_mod, "run_backfill_with", fake_run_backfill_with)

    result = await screener_backfill_mod.run_backfill(tmp_path)

    assert result["sdir"] == tmp_path / "screener"
    assert result["adj"] == [(dt.date(2026, 6, 1), 3.0)]
    assert result["raw"] == [DailyBar("005930", dt.date(2026, 6, 1), 1.0, 2.0, 1.0, 2.0, 10)]
    assert [call for call in calls if isinstance(call, dict)] == [
        {
            "scheduler": scheduler,
            "data_dir": tmp_path,
            "key": ("screener-backfill-adj", "005930", "20260601", "20260601"),
            "endpoint": "screener-daily",
            "priority": "background",
            "cooldown_scope": "screener-daily",
        },
        {
            "scheduler": scheduler,
            "data_dir": tmp_path,
            "key": ("screener-backfill-raw", "005930", "20260601", "20260601"),
            "endpoint": "screener-daily",
            "priority": "background",
            "cooldown_scope": "screener-daily",
        },
    ]
