from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import factor_backfill
from hoga.api.screener_factors import read_factors

_UNADJ_SCHEMA = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64,
                 "high": pl.Float64, "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _seed_unadjusted(sdir: Path):
    sdir.mkdir(parents=True, exist_ok=True)
    rows = []
    for d, c in [(dt.date(2021, 4, 5), 502000.0), (dt.date(2021, 4, 15), 120500.0)]:
        rows.append({"code": "035720", "date": d, "open": c, "high": c, "low": c, "close": c, "volume": 100})
    for d in (dt.date(2021, 4, 5), dt.date(2021, 4, 15)):
        rows.append({"code": "000001", "date": d, "open": 1000.0, "high": 1000.0, "low": 1000.0, "close": 1000.0, "volume": 5})
    pl.DataFrame(rows, schema=_UNADJ_SCHEMA).write_parquet(sdir / "daily_unadjusted.parquet")


def _fake_fetch_adj(adj_close_by_code):
    async def fetch(code: str, frm: str, to: str):
        return adj_close_by_code.get(code, [])
    return fetch


def test_backfill_writes_factor_segments(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed_unadjusted(sdir)
    fetch = _fake_fetch_adj({
        "035720": [(dt.date(2021, 4, 5), 100759.0), (dt.date(2021, 4, 15), 120500.0)],
        "000001": [(dt.date(2021, 4, 5), 1000.0), (dt.date(2021, 4, 15), 1000.0)],
    })
    n = asyncio.run(factor_backfill(sdir, fetch_adj=fetch))
    assert n == 2
    f = read_factors(sdir / "factors.parquet")
    assert f is not None
    assert set(f["code"].unique().to_list()) == {"035720", "000001"}
    kakao = f.filter(pl.col("code") == "035720").sort("seg_start")
    assert kakao.height == 2
    assert abs(kakao["factor"][0] - 100759.0 / 502000.0) < 1e-9
    assert kakao["factor"][1] == 1.0


def test_backfill_resumable_skips_done_codes(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed_unadjusted(sdir)
    calls: list[str] = []

    async def counting_fetch(code: str, frm: str, to: str):
        calls.append(code)
        return [(dt.date(2021, 4, 5), 1000.0), (dt.date(2021, 4, 15), 1000.0)]

    asyncio.run(factor_backfill(sdir, fetch_adj=counting_fetch, codes=["000001"]))
    assert calls == ["000001"]
    asyncio.run(factor_backfill(sdir, fetch_adj=counting_fetch, codes=["000001", "035720"]))
    assert calls == ["000001", "035720"]  # 000001 already done → not re-fetched


def test_backfill_skips_empty_adj_code(tmp_path):
    sdir = tmp_path / "screener"; _seed_unadjusted(sdir)
    fetch = _fake_fetch_adj({"000001": [(dt.date(2021,4,5),1000.0),(dt.date(2021,4,15),1000.0)]})  # 035720 → []
    n = asyncio.run(factor_backfill(sdir, fetch_adj=fetch))
    assert n == 1
    f = read_factors(sdir / "factors.parquet")
    assert set(f["code"].unique().to_list()) == {"000001"}


def test_backfill_one_failing_fetch_does_not_abort_others(tmp_path):
    sdir = tmp_path / "screener"; _seed_unadjusted(sdir)
    async def fetch(code, frm, to):
        if code == "035720":
            raise RuntimeError("boom")
        return [(dt.date(2021,4,5),1000.0),(dt.date(2021,4,15),1000.0)]
    n = asyncio.run(factor_backfill(sdir, fetch_adj=fetch, codes=["000001","035720"]))  # no crash
    f = read_factors(sdir / "factors.parquet")
    assert "000001" in f["code"].unique().to_list()
    assert "035720" not in f["code"].unique().to_list()
