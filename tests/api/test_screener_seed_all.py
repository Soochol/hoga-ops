"""seed_all orchestration: export→seed→derive→status, no docker/DB needed.

Monkeypatches the 2 DB-export functions to write tiny fixture CSVs whose
headers match what seed_daily_from_csv / seed_stocks_from_csv SELECT.
"""
from __future__ import annotations

from pathlib import Path

import polars as pl

from hoga.api import screener_store


_DAILY_CSV = (
    "code,date,open,high,low,close,volume\n"
    "000001,2026-05-13,100,110,90,105,1000\n"
    "000001,2026-05-14,105,120,100,118,1200\n"
    "000002,2026-05-13,50,55,48,52,500\n"
    "000002,2026-05-14,52,60,51,59,700\n"
)
_STOCKS_CSV = (
    "code,name,market,is_etf,is_halted\n"
    "000001,에이,KOSPI,false,false\n"
    "000002,비,KOSDAQ,false,false\n"
)


def test_seed_all_builds_all_artifacts(tmp_path, monkeypatch):
    def fake_export_daily(csv_path: Path, **kwargs) -> None:
        Path(csv_path).write_text(_DAILY_CSV, encoding="utf-8")

    def fake_export_stocks(csv_path: Path, **kwargs) -> None:
        Path(csv_path).write_text(_STOCKS_CSV, encoding="utf-8")

    monkeypatch.setattr(screener_store, "export_db_to_csv", fake_export_daily)
    monkeypatch.setattr(screener_store, "export_stocks_from_db", fake_export_stocks)

    n = screener_store.seed_all(tmp_path, now_ms=1)

    assert n == 2  # two stocks
    sdir = tmp_path / "screener"
    for name in ("daily_unadjusted.parquet", "daily_adjusted.parquet",
                 "stocks.parquet", "status.json"):
        assert (sdir / name).exists(), f"missing {name}"

    # status reflects the seeded archive
    status = screener_store.read_status(sdir / "status.json")
    assert status is not None
    assert status.last_raw_date == "20260514"
    assert status.universe_size == 2

    # code stays VARCHAR (leading-zero preserved)
    assert pl.read_parquet(sdir / "stocks.parquet")["code"].dtype == pl.Utf8
