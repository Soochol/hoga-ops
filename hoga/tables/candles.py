"""Candles table — 1-minute OHLCV bars parsed from chart.tsv.

Unlike the other table modules, Candles does not register with the first.tsv
dispatcher. Its rows come from a separate endpoint (chart.php) which the
collector saves to chart.tsv. The parser orchestrator calls ``parse_row`` here
directly.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
from pydantic import BaseModel

from hoga.tables.dispatch import FieldCountError, split_row

CANDLE_MIN_FIELDS = 8


# === In-memory entity ===


@dataclass(frozen=True)
class Candle:
    ts_ms: int
    open_: int
    close_: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Parser ===


def parse_row(line: str) -> Candle:
    """Parse one chart.tsv row into a Candle.

    chart.tsv columns: relative_ts_ms, HH:MM:SS, open, close, high, low,
    vol_a, vol_b, [unknown], cum_a, cum_b. We only retain the first 8.
    """
    parts = split_row(line)
    if len(parts) < CANDLE_MIN_FIELDS:
        raise FieldCountError(f"candle row expects >={CANDLE_MIN_FIELDS} fields, got {len(parts)}")
    return Candle(
        ts_ms=int(parts[0]),
        open_=int(parts[2]),
        close_=int(parts[3]),
        high=int(parts[4]),
        low=int(parts[5]),
        vol_a=int(parts[6]),
        vol_b=int(parts[7]),
    )


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("open", pa.int32()),
        pa.field("close", pa.int32()),
        pa.field("high", pa.int32()),
        pa.field("low", pa.int32()),
        pa.field("vol_a", pa.int32()),
        pa.field("vol_b", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    from hoga.api._atomic_write import atomic_write_parquet_table

    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


# === API representation ===


class ApiCandle(BaseModel):
    ts_ms: int
    open: int
    close: int
    high: int
    low: int
    vol_a: int
    vol_b: int


# === Query (returns list[ApiCandle] directly) ===


def query_all(con: duckdb.DuckDBPyConnection, *, path: Path) -> list[ApiCandle]:
    rows = con.execute(
        'SELECT ts_ms, "open", "close", high, low, vol_a, vol_b '
        "FROM read_parquet(?) ORDER BY ts_ms ASC",
        [str(path)],
    ).fetchall()
    return [
        ApiCandle(ts_ms=r[0], open=r[1], close=r[2], high=r[3], low=r[4], vol_a=r[5], vol_b=r[6])
        for r in rows
    ]


def query_price_range(con: duckdb.DuckDBPyConnection, *, path: Path) -> tuple[int, int] | None:
    """Return ``(MIN(low), MAX(high))`` across the candles, or ``None`` if the
    table is empty (NULL aggregates).

    This owns the ``low`` / ``high`` candle-column knowledge (ADR-0001) so
    callers that need a price grid — e.g. the range bundle's volume-profile
    slice — get the spread without re-deriving the schema. Mirrors
    ``snapshots.query_time_bounds``'s ``tuple | None`` shape.
    """
    row = con.execute(
        "SELECT MIN(low), MAX(high) FROM read_parquet(?)", [str(path)]
    ).fetchone()
    if row is None or row[0] is None or row[1] is None:
        return None
    return int(row[0]), int(row[1])
