"""DuckDB-driven session bundle slices, one builder per slice."""
from __future__ import annotations

from pathlib import Path

import duckdb

from hoga.api.models import QuoteRatio, QuoteRatioPoint
from hoga.api.timeenc import hhmmssms_to_unix_ms, ms_from_midnight_to_unix_ms
from hoga.tables import candles as candles_tbl
from hoga.tables.candles import ApiCandle


def build_candles_slice(
    conn: duckdb.DuckDBPyConnection, *, code: str, date: str, data_dir: Path
) -> list[ApiCandle]:
    path = data_dir / "parquet" / date / code / "candles.parquet"
    rows = candles_tbl.query_all(conn, path=path)
    return [
        r.model_copy(update={"ts_ms": ms_from_midnight_to_unix_ms(date, r.ts_ms)})
        for r in rows
    ]


def build_quote_ratio_slice(
    conn: duckdb.DuckDBPyConnection,
    *,
    code: str,
    date: str,
    data_dir: Path,
    bucket_ms: int = 1000,
) -> QuoteRatio:
    path = str(data_dir / "parquet" / date / code / "snapshots.parquet")
    rows = conn.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 (ask_q1 + ask_q2 + ask_q3 + ask_q4 + ask_q5 +
                  ask_q6 + ask_q7 + ask_q8 + ask_q9 + ask_q10) AS ask_total,
                 (bid_q1 + bid_q2 + bid_q3 + bid_q4 + bid_q5 +
                  bid_q6 + bid_q7 + bid_q8 + bid_q9 + bid_q10) AS bid_total,
                 ts_ms / {bucket_ms} AS bucket,
                 ROW_NUMBER() OVER (PARTITION BY ts_ms / {bucket_ms}
                                   ORDER BY ts_ms DESC) AS rn
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms}, bid_total, ask_total
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [path],
    ).fetchall()
    return QuoteRatio(
        bucket_ms=bucket_ms,
        points=[
            QuoteRatioPoint(
                t=hhmmssms_to_unix_ms(date, r[0]),
                bid_total=int(r[1]),
                ask_total=int(r[2]),
            )
            for r in rows
        ],
    )
