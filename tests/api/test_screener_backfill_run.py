from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path
from types import SimpleNamespace

import polars as pl
import pytest

from hoga.api import screener_backfill as screener_backfill_mod
from hoga.api.screener_backfill import run_backfill_with
from hoga.api.screener_factors import read_factors
from hoga.api.screener_store import DailyBar
from hoga.util.timeenc import KST

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
    """PR-F(#1042) 칼 컷오버 — 소스는 키움 `ka10081` 이다.

    계정 차원(`data_dir`·`endpoint`·`cooldown_scope`)이 사라졌다: 키움 유량은
    TR별이라 고를 계정이 없다(#1015). 버킷 키는 `api_id` 다.

    **수정주가/원주가 2벌이 이 테스트의 핵심**이다. 키움 `upd_stkpc_tp` 는 KIS 의
    `FID_ORG_ADJ_PRC` 와 극성이 반대라(1=수정주가) 옮기다 뒤집히기 쉽다. 여기서는
    불리언이 어댑터까지 그대로 도달하는지만 보고, 와이어 값 변환은
    `test_kiwoom_daily_candles.py` 가 액면분할 리트머스로 못 박는다.
    """
    from hoga.live import kiwoom_access, kiwoom_daily_candles, kiwoom_rest_runtime

    scheduler = object()
    client = object()
    calls = []
    t_ms = int(dt.datetime(2026, 6, 1, tzinfo=KST).timestamp() * 1000)

    async def fake_fetch_daily_candles(client_arg, code, frm, to, *, venue="KRX", adjust=True):
        calls.append(("adapter", client_arg, code, frm, to, adjust))
        return SimpleNamespace(candles=[
            SimpleNamespace(
                t_ms=t_ms, open=1.0, high=2.0, low=1.0,
                close=3.0 if adjust else 2.0, volume=10,
            )
        ])

    async def fake_run_with_capacity(scheduler_arg, *, key, api_id, priority, fetch_fn, client):
        calls.append({
            "scheduler": scheduler_arg, "key": key,
            "api_id": api_id, "priority": priority,
        })
        return await fetch_fn(client)

    async def fake_run_backfill_with(sdir, *, fetch_adj, fetch_raw, now_ms=None):
        adj = await fetch_adj("005930", "20260601", "20260601")
        raw = await fetch_raw("005930", "20260601", "20260601")
        return {"adj": adj, "raw": raw, "sdir": sdir}

    monkeypatch.setattr(
        kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: client
    )
    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_scheduler", lambda: scheduler)
    monkeypatch.setattr(kiwoom_access, "run_with_capacity", fake_run_with_capacity)
    monkeypatch.setattr(
        kiwoom_daily_candles, "fetch_daily_candles", fake_fetch_daily_candles
    )
    monkeypatch.setattr(screener_backfill_mod, "run_backfill_with", fake_run_backfill_with)

    result = await screener_backfill_mod.run_backfill(tmp_path)

    assert result["sdir"] == tmp_path / "screener"
    assert result["adj"] == [(dt.date(2026, 6, 1), 3.0)]
    assert result["raw"] == [DailyBar("005930", dt.date(2026, 6, 1), 1.0, 2.0, 1.0, 2.0, 10)]
    assert [call for call in calls if isinstance(call, dict)] == [
        {
            "scheduler": scheduler,
            "key": ("screener-backfill-adj", "005930", "20260601", "20260601"),
            "api_id": "ka10081",
            "priority": "background",
        },
        {
            "scheduler": scheduler,
            "key": ("screener-backfill-raw", "005930", "20260601", "20260601"),
            "api_id": "ka10081",
            "priority": "background",
        },
    ]
    assert [c[5] for c in calls if isinstance(c, tuple)] == [True, False], (
        "수정주가 1벌 · 원주가 1벌 — 극성이 뒤집히면 여기서 걸린다"
    )


async def test_run_backfill_fails_loudly_without_kiwoom_credentials(tmp_path, monkeypatch):
    """무자격이면 조용히 skip 하지 않고 loud fail 한다 — KIS 시절 규약을 유지한다."""
    from hoga.live import kiwoom_rest_runtime

    monkeypatch.setattr(kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: None)
    with pytest.raises(RuntimeError, match="자격증명"):
        await screener_backfill_mod.run_backfill(tmp_path)
