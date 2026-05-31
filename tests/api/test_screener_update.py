import polars as pl
from pathlib import Path
from hoga.api.screener_store import last_raw_date, append_rows, write_status, read_status


def test_last_date_and_append(tmp_path: Path):
    p = tmp_path / "u.parquet"
    pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
                  "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                  pl.col("date").str.to_date()).write_parquet(p)
    assert last_raw_date(p) == "20260513"
    append_rows(p, pl.DataFrame({"code": ["000001"], "date": ["2026-05-14"], "open": [2.0],
        "high": [2.0], "low": [2.0], "close": [2.0], "volume": [2]}).with_columns(
        pl.col("date").str.to_date()))
    assert last_raw_date(p) == "20260514"


def test_append_is_idempotent_on_code_date(tmp_path: Path):
    p = tmp_path / "u.parquet"
    base = pl.DataFrame({"code": ["000001"], "date": ["2026-05-13"], "open": [1.0], "high": [1.0],
                         "low": [1.0], "close": [1.0], "volume": [1]}).with_columns(
                         pl.col("date").str.to_date())
    base.write_parquet(p)
    dup = pl.DataFrame({"code": ["000001"], "date": ["2026-05-14"], "open": [2.0], "high": [2.0],
                        "low": [2.0], "close": [2.0], "volume": [2]}).with_columns(
                        pl.col("date").str.to_date())
    append_rows(p, dup)
    append_rows(p, dup)  # 같은 (code,date) 두 번 → 한 행만
    got = pl.read_parquet(p)
    assert got.filter((pl.col("code") == "000001") & (pl.col("date") == pl.date(2026, 5, 14))).height == 1


def test_status_roundtrip(tmp_path: Path):
    sp = tmp_path / "status.json"
    write_status(sp, last_raw_date="20260514", universe_size=2, derive_ms=3, now_ms=100)
    s = read_status(sp)
    assert s.last_raw_date == "20260514" and s.schema_version == 1
