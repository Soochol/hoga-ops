"""DuckDB-driven session bundle slices, one builder per slice."""
from __future__ import annotations

from pathlib import Path

import duckdb

from hoga.api.timeenc import ms_from_midnight_to_unix_ms
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
