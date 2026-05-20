"""Snapshots table — 10-level orderbook state.

Each event type 2 row is a full state snapshot. In-memory the entity uses
10-tuples for price/qty/delta arrays; on disk those are flattened into
``ask_p1..ask_p10``, ``ask_q1..ask_q10``, ``ask_d1..ask_d10`` etc. columns.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

ORDERBOOK_LEVELS = 10

# === In-memory entity ===


@dataclass(frozen=True)
class Orderbook:
    ts_ms: int
    seq: int
    ask_p: tuple[int, ...]  # length 10
    ask_q: tuple[int, ...]
    ask_d: tuple[int, ...]
    bid_p: tuple[int, ...]
    bid_q: tuple[int, ...]
    bid_d: tuple[int, ...]
    tot_ask: int
    tot_ask_d: int
    tot_bid: int
    tot_bid_d: int


# === TSV parser ===


def _parse_orderbook(parts: list[str]) -> Orderbook:
    base = 6
    ask_p = tuple(int(x) for x in parts[base : base + ORDERBOOK_LEVELS])
    ask_q = tuple(int(x) for x in parts[base + ORDERBOOK_LEVELS : base + 2 * ORDERBOOK_LEVELS])
    ask_d = tuple(int(x) for x in parts[base + 2 * ORDERBOOK_LEVELS : base + 3 * ORDERBOOK_LEVELS])
    bid_p = tuple(int(x) for x in parts[base + 3 * ORDERBOOK_LEVELS : base + 4 * ORDERBOOK_LEVELS])
    bid_q = tuple(int(x) for x in parts[base + 4 * ORDERBOOK_LEVELS : base + 5 * ORDERBOOK_LEVELS])
    bid_d = tuple(int(x) for x in parts[base + 5 * ORDERBOOK_LEVELS : base + 6 * ORDERBOOK_LEVELS])
    totals_start = base + 6 * ORDERBOOK_LEVELS
    return Orderbook(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        ask_p=ask_p,
        ask_q=ask_q,
        ask_d=ask_d,
        bid_p=bid_p,
        bid_q=bid_q,
        bid_d=bid_d,
        tot_ask=int(parts[totals_start]),
        tot_ask_d=int(parts[totals_start + 1]),
        tot_bid=int(parts[totals_start + 2]),
        tot_bid_d=int(parts[totals_start + 3]),
    )


EXPECTED_FIELD_COUNTS: dict[int, int] = {2: 70}
PARSERS: dict[int, Callable[[list[str]], Orderbook]] = {2: _parse_orderbook}


# === Wire schema ===


def _build_schema() -> pa.Schema:
    fields: list[pa.Field] = [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
    ]
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, ORDERBOOK_LEVELS + 1):
            fields.append(pa.field(f"{prefix}{i}", pa.int32()))
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        fields.append(pa.field(total, pa.int32()))
    return pa.schema(fields)


PARQUET_SCHEMA: pa.Schema = _build_schema()


# === Persist (flattens tuple-fields into per-level columns) ===


def write_parquet(snapshots: Iterable[Orderbook], path: Path) -> None:
    rows = sorted(snapshots, key=lambda o: o.ts_ms)
    cols: dict[str, pa.Array] = {
        "ts_ms": pa.array([o.ts_ms for o in rows], type=pa.int64()),
        "seq": pa.array([o.seq for o in rows], type=pa.int32()),
    }
    for prefix, attr in (
        ("ask_p", "ask_p"),
        ("ask_q", "ask_q"),
        ("ask_d", "ask_d"),
        ("bid_p", "bid_p"),
        ("bid_q", "bid_q"),
        ("bid_d", "bid_d"),
    ):
        for i in range(ORDERBOOK_LEVELS):
            cols[f"{prefix}{i + 1}"] = pa.array(
                [getattr(o, attr)[i] for o in rows], type=pa.int32()
            )
    for total in ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"):
        cols[total] = pa.array([getattr(o, total) for o in rows], type=pa.int32())
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === Within-table invariants ===


class SnapshotValidationError(ValueError):
    """A snapshots-table invariant was violated (e.g. price arrays out of order)."""


def validate(snapshots: list[Orderbook], *, lenient: bool = False) -> None:
    """Check snapshots-table invariants.

    Invariants:
    - ``ask_p`` is non-decreasing (excluding placeholder ``0``s at the tail).
    - ``bid_p`` is non-increasing (excluding placeholder ``0``s at the tail).

    These mirror Korean orderbook ladder semantics: best ask is the lowest sell
    price, deeper asks rise; best bid is the highest buy price, deeper bids fall.

    In strict mode (default) raises ``SnapshotValidationError`` on first violation.
    In lenient mode skips violations silently.
    """
    for ob in snapshots:
        nz_ask = [p for p in ob.ask_p if p > 0]
        if nz_ask != sorted(nz_ask):
            if lenient:
                continue
            raise SnapshotValidationError(f"ask prices not sorted at seq={ob.seq}: {nz_ask}")
        nz_bid = [p for p in ob.bid_p if p > 0]
        if nz_bid != sorted(nz_bid, reverse=True):
            if lenient:
                continue
            raise SnapshotValidationError(f"bid prices not sorted at seq={ob.seq}: {nz_bid}")


# === API representation ===


class ApiOrderbookSnapshot(BaseModel):
    ts_ms: int
    seq: int
    ask_p: list[int]  # length 10
    ask_q: list[int]
    ask_d: list[int]
    bid_p: list[int]
    bid_q: list[int]
    bid_d: list[int]
    tot_ask: int
    tot_ask_d: int
    tot_bid: int
    tot_bid_d: int


# === Query (returns ApiOrderbookSnapshot directly — unflattens flat columns inline) ===


def _build_query_cols() -> tuple[str, ...]:
    cols: list[str] = ["ts_ms", "seq"]
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, ORDERBOOK_LEVELS + 1):
            cols.append(f"{prefix}{i}")
    cols.extend(("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d"))
    return tuple(cols)


_QUERY_COLS: tuple[str, ...] = _build_query_cols()
_SELECT: str = ", ".join(_QUERY_COLS)


def query_at(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int
) -> ApiOrderbookSnapshot | None:
    """Return the latest snapshot at ts_ms <= t_ms as an ApiOrderbookSnapshot, or None
    if before any data."""
    row = con.execute(
        f"SELECT {_SELECT} FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT 1",
        [str(path), t_ms],
    ).fetchone()
    if row is None:
        return None
    by_name = dict(zip(_QUERY_COLS, row, strict=True))
    return ApiOrderbookSnapshot(
        ts_ms=by_name["ts_ms"],
        seq=by_name["seq"],
        ask_p=[by_name[f"ask_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        ask_q=[by_name[f"ask_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        ask_d=[by_name[f"ask_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_p=[by_name[f"bid_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_q=[by_name[f"bid_q{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        bid_d=[by_name[f"bid_d{i}"] for i in range(1, ORDERBOOK_LEVELS + 1)],
        tot_ask=by_name["tot_ask"],
        tot_ask_d=by_name["tot_ask_d"],
        tot_bid=by_name["tot_bid"],
        tot_bid_d=by_name["tot_bid_d"],
    )


def query_time_bounds(con: duckdb.DuckDBPyConnection, *, path: Path) -> tuple[int, int] | None:
    """Return (min ts_ms, max ts_ms) across the snapshots, or None if empty."""
    row = con.execute("SELECT min(ts_ms), max(ts_ms) FROM read_parquet(?)", [str(path)]).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0]), int(row[1])


def query_first_ts(con: duckdb.DuckDBPyConnection, *, path: Path) -> int | None:
    """Return min ts_ms or None."""
    bounds = query_time_bounds(con, path=path)
    return bounds[0] if bounds else None
