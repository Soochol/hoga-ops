import polars as pl
from pathlib import Path
from hoga.api.screener_store import derive_adjusted


def test_derive_writes_adjusted(tmp_path: Path):
    raw = tmp_path / "u.parquet"
    pl.DataFrame({
        "code": ["A","A","A"], "date": ["2021-04-13","2021-04-14","2021-04-15"],
        "open":[500.0,500.0,100.0],"high":[510.0,510.0,102.0],
        "low":[495.0,495.0,99.0],"close":[500.0,500.0,100.0],"volume":[1000,1000,5000],
    }).with_columns(pl.col("date").str.to_date()).write_parquet(raw)
    out = tmp_path / "a.parquet"
    ms = derive_adjusted(raw, out)
    assert ms >= 0 and out.exists()
    got = pl.read_parquet(out).sort("date")
    assert abs(got["close"].to_list()[0] - 100.0) < 1.0
