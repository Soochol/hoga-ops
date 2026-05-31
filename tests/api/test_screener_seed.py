import duckdb
from pathlib import Path
from hoga.api.screener_store import seed_daily_from_csv, seed_stocks_from_csv


def test_seed_preserves_leading_zero_code(tmp_path: Path):
    csv = tmp_path / "in.csv"
    csv.write_text("code,date,open,high,low,close,volume\n"
                   "005930,2026-05-14,300,320,295,317,1000\n"
                   "000660,2026-05-14,2300,2350,2280,2333,500\n")
    out = tmp_path / "daily_unadjusted.parquet"
    n = seed_daily_from_csv(csv, out)
    assert n == 2
    rows = duckdb.sql(f"SELECT code, typeof(code) t FROM '{out}' ORDER BY code").fetchall()
    assert rows[0][0] == "000660" and rows[0][1] == "VARCHAR"
    assert rows[1][0] == "005930"  # not int 5930


def test_seed_stocks_preserves_leading_zero_code(tmp_path: Path):
    csv = tmp_path / "stocks.csv"
    csv.write_text("code,name,market,is_etf,is_halted\n"
                   "005930,삼성전자,KOSPI,false,false\n")
    out = tmp_path / "stocks.parquet"
    n = seed_stocks_from_csv(csv, out)
    assert n == 1
    rows = duckdb.sql(f"SELECT code, typeof(code) t FROM '{out}'").fetchall()
    assert rows[0][0] == "005930"   # not int 5930
    assert rows[0][1] == "VARCHAR"
