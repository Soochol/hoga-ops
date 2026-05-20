"""DuckDB-driven session bundle slices, one builder per slice."""
from __future__ import annotations

from pathlib import Path

from hoga.api.timeenc import ms_from_midnight_to_unix_ms
from hoga.tables.candles import ApiCandle


def build_candles_slice(conn, *, code: str, date: str, data_dir: Path) -> list[ApiCandle]:
    path = str(data_dir / "parquet" / date / code / "candles.parquet")
    rows = conn.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [path],
    ).fetchall()
    return [
        ApiCandle(
            ts_ms=ms_from_midnight_to_unix_ms(date, r[0]),
            open=r[1],
            close=r[2],
            high=r[3],
            low=r[4],
            vol_a=r[5],
            vol_b=r[6],
        )
        for r in rows
    ]
