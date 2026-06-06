"""fills 테이블 — 10초 체결강도 구간합 (그릴링 Q4, spec §8).

trades.parquet(개별 체결) 저장 중단의 대체 artifact. side 분류(±1만,
Auction Cross 제외)는 다운샘플러가 write-time에 이미 적용했으므로 이 쿼리는
시간 재버킷(합의 합)만 한다 — 10초는 모든 Timeframe bucket_ms(60s~1800s)에
정확히 중첩된다.
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq

from hoga.api.timeenc import hhmmssms_to_intra_ms_sql
from hoga.tables.trades import FillStrengthRow

PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),   # HHMMSSmmm packed-decimal (ADR-0010/0049)
        pa.field("seq", pa.int64()),
        pa.field("buy_qty", pa.int64()),
        pa.field("sell_qty", pa.int64()),
    ]
)


@dataclass(frozen=True)
class Fill:
    ts_ms: int
    seq: int
    buy_qty: int
    sell_qty: int


def write_fills_parquet(rows: list[Fill], path: Path) -> None:
    cols = {
        field.name: pa.array([getattr(r, field.name) for r in rows], type=field.type)
        for field in PARQUET_SCHEMA
    }
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


def query_fill_strength(
    con: duckdb.DuckDBPyConnection, *, path: Path, bucket_ms: int
) -> list[FillStrengthRow]:
    """trades.query_fill_strength 와 동일 반환형 — bundle이 분기 없이 재사용."""
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = con.execute(
        f"""
        SELECT (({intra_ms_expr} // {bucket_ms}) * {bucket_ms}) AS bucket,
               SUM(buy_qty) AS buy_qty,
               SUM(sell_qty) AS sell_qty
        FROM read_parquet(?)
        GROUP BY 1 ORDER BY 1
        """,
        [str(path)],
    ).fetchall()
    return [
        FillStrengthRow(bucket_intra_ms=int(r[0]), buy_qty=int(r[1]), sell_qty=int(r[2]))
        for r in rows
    ]
