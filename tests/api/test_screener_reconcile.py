from __future__ import annotations

import asyncio
import datetime as dt
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import ReconcileReport, reconcile_raw
from hoga.api.screener_store import DailyBar

_S = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _row(code, d, c):
    return DailyBar(code=code, date=d, open=c, high=c, low=c, close=c, volume=10)


def _seed(sdir: Path, rows):
    sdir.mkdir(parents=True, exist_ok=True)
    pl.DataFrame([vars(r) for r in rows], schema=_S).write_parquet(sdir / "daily_unadjusted.parquet")


def _fetch(raw_by_code):
    async def f(code, frm, to):
        return raw_by_code.get(code, [])
    return f


def test_value_match_and_gap_fill(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed(sdir, [_row("000660", dt.date(2015, 1, 2), 30000.0)])
    fetch = _fetch({"000660": [_row("000660", dt.date(2014, 1, 2), 25000.0),
                               _row("000660", dt.date(2015, 1, 2), 30000.0)]})
    rep = asyncio.run(reconcile_raw(sdir, fetch_raw=fetch, codes=["000660"]))
    assert isinstance(rep, ReconcileReport)
    assert rep.value_mismatches == 0
    assert rep.filled_rows == 1
    merged = pl.read_parquet(sdir / "daily_unadjusted.parquet").sort("date")
    assert merged["date"].to_list() == [dt.date(2014, 1, 2), dt.date(2015, 1, 2)]


def test_value_mismatch_recorded_not_overwritten(tmp_path: Path):
    sdir = tmp_path / "screener"
    _seed(sdir, [_row("005930", dt.date(2024, 1, 2), 70000.0)])
    fetch = _fetch({"005930": [_row("005930", dt.date(2024, 1, 2), 71000.0)]})
    rep = asyncio.run(reconcile_raw(sdir, fetch_raw=fetch, codes=["005930"]))
    assert rep.value_mismatches == 1
    assert rep.filled_rows == 0
    assert pl.read_parquet(sdir / "daily_unadjusted.parquet")["close"][0] == 70000.0


def test_recent_overwrite_and_old_preserved(tmp_path: Path):
    """overwrite_recent_days=14: recent mismatch is overwritten by KIS; old mismatch preserved.

    Disk has two mismatching rows:
      - OLD: 2024-01-02 (old date, beyond 14-day window from max=2024-06-01) → disk preserved
      - RECENT: 2024-06-01 (== disk max, within 14-day window) → KIS value wins

    Both rows count toward value_mismatches.  recent_overwrites == 1.
    """
    old_date = dt.date(2024, 1, 2)
    recent_date = dt.date(2024, 6, 1)
    sdir = tmp_path / "screener"
    _seed(sdir, [
        _row("005930", old_date, 70000.0),     # OLD mismatch: disk=70000, KIS=71000
        _row("005930", recent_date, 80000.0),  # RECENT mismatch: disk=80000, KIS=81000
    ])
    fetch = _fetch({"005930": [
        _row("005930", old_date, 71000.0),     # KIS old close (different)
        _row("005930", recent_date, 81000.0),  # KIS recent close (different)
    ]})
    rep = asyncio.run(reconcile_raw(sdir, fetch_raw=fetch, codes=["005930"],
                                    overwrite_recent_days=14))

    # Both mismatches are counted
    assert rep.value_mismatches == 2
    # Only the recent one is overwritten
    assert rep.recent_overwrites == 1
    # Gap-fill count is for pure new rows only (none here)
    assert rep.filled_rows == 0

    disk = pl.read_parquet(sdir / "daily_unadjusted.parquet").sort("date")
    close_by_date = dict(zip(disk["date"].to_list(), disk["close"].to_list()))
    # Old mismatch: disk value preserved
    assert close_by_date[old_date] == 70000.0
    # Recent mismatch: KIS value overwrote disk value
    assert close_by_date[recent_date] == 81000.0
