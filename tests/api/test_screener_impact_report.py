from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import polars as pl

from hoga.api.screener_backfill import build_impact_report

_A = {"code": pl.Utf8, "date": pl.Date, "open": pl.Float64, "high": pl.Float64,
      "low": pl.Float64, "close": pl.Float64, "volume": pl.Int64}


def _adj(rows):
    return pl.DataFrame(rows, schema=_A)


def _r(code, d, close, vol):
    return {"code": code, "date": d, "open": close, "high": close, "low": close, "close": close, "volume": vol}


def test_report_lists_changed_codes(tmp_path: Path):
    sdir = tmp_path / "screener"
    sdir.mkdir(parents=True)
    old = _adj([_r("035720", dt.date(2021, 4, 5), 502000.0, 100), _r("000001", dt.date(2021, 4, 5), 1000.0, 5)])
    new = _adj([_r("035720", dt.date(2021, 4, 5), 100759.0, 498), _r("000001", dt.date(2021, 4, 5), 1000.0, 5)])
    old.write_parquet(sdir / "daily_adjusted.old.parquet")
    new.write_parquet(sdir / "daily_adjusted.parquet")

    rep = build_impact_report(sdir, old_path=sdir / "daily_adjusted.old.parquet")
    assert rep["changed_codes"] == 1
    assert "035720" in rep["changed_code_sample"]
    assert "000001" not in rep["changed_code_sample"]
    written = json.loads((sdir / "impact-report.json").read_text())
    assert written["changed_codes"] == 1
