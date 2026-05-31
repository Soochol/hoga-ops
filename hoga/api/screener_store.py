from __future__ import annotations
from pathlib import Path
import duckdb

# parquet 컬럼 dtype 계약. code 는 전 구간 VARCHAR (leading-zero 보존).
_DAILY_COLS = {
    "code": "VARCHAR", "date": "DATE", "open": "DOUBLE", "high": "DOUBLE",
    "low": "DOUBLE", "close": "DOUBLE", "volume": "BIGINT",
}


def seed_daily_from_csv(csv_path: Path, out_path: Path) -> int:
    """CSV(원주가 일봉) → daily_unadjusted.parquet. code VARCHAR 강제, count 반환."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(":memory:")
    csv_s = str(csv_path).replace("'", "''")
    out_s = str(out_path).replace("'", "''")
    con.execute(
        f"COPY (SELECT code, CAST(date AS DATE) date, open, high, low, close, volume "
        f"FROM read_csv('{csv_s}', header=true, types={{'code':'VARCHAR'}})) "
        f"TO '{out_s}' (FORMAT parquet, COMPRESSION zstd)"
    )
    return con.execute(f"SELECT count(*) FROM '{out_s}'").fetchone()[0]
