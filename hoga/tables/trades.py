"""Trades table — continuous trading + Auction Cross matchings.

This module owns everything about trades.parquet: in-memory entity, TSV parsers
for event types 1 (continuous trade) and 3 (single-price/premarket summary),
the pyarrow schema, the writer, DuckDB query helpers, the API model, and the
row→API mapping.

Auction Cross trades have ``side=0`` and ``cum_vol=0`` (they are excluded from
the parser's cum_vol monotonicity check; see hoga/parser/__init__.py).
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pyarrow as pa

from hoga.api.timeenc import hhmmssms_to_intra_ms_sql

# === In-memory entity ===


@dataclass(frozen=True)
class Trade:
    ts_ms: int
    seq: int
    price: int
    change_pct: float
    qty: int
    side: int  # +1 buy-aggressor, -1 sell-aggressor, 0 Auction Cross / premarket
    cum_vol: int
    cum_trades: int
    low_so_far: int
    high_so_far: int
    net_pressure: int
    # Forensic / not-yet-decoded fields, kept for analysis but not exposed via API.
    unknown_14: int
    unknown_16: float
    unknown_17: float
    unknown_18: float


# === TSV parsers (registered with dispatcher in Task 6) ===


def _parse_continuous_trade(parts: list[str]) -> Trade:
    """Event type 1: regular tick.

    qty is signed (+N buy-aggressor / -N sell-aggressor / N=auction cross).
    """
    qty_raw = parts[8]
    if qty_raw.startswith("+"):
        side = 1
        qty = int(qty_raw[1:])
    elif qty_raw.startswith("-"):
        side = -1
        qty = int(qty_raw[1:])
    else:
        side = 0
        qty = int(qty_raw)
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=int(parts[6]),
        change_pct=float(parts[7]),
        qty=qty,
        side=side,
        cum_vol=int(parts[9]),
        cum_trades=int(parts[10]),
        low_so_far=int(parts[11]),
        high_so_far=int(parts[12]),
        net_pressure=int(parts[14]),
        unknown_14=int(parts[13]),
        unknown_16=float(parts[15]),
        unknown_17=float(parts[16]),
        unknown_18=float(parts[17]),
    )


def _parse_premarket_summary(parts: list[str]) -> Trade:
    """Event type 3: single-price-auction summary (opening, closing, pre-market).

    Stored as a side=0 trade.
    """
    return Trade(
        ts_ms=int(parts[4]),
        seq=int(parts[3]),
        price=0,
        change_pct=0.0,
        qty=int(parts[8]),
        side=0,
        cum_vol=0,
        cum_trades=0,
        low_so_far=0,
        high_so_far=0,
        net_pressure=0,
        unknown_14=int(parts[6]),
        unknown_16=float(parts[7]),
        unknown_17=float(parts[9]),
        unknown_18=0.0,
    )


# Field counts expected for each event type this module handles.
EXPECTED_FIELD_COUNTS: dict[int, int] = {1: 18, 3: 10}

# Dispatcher registry: event_type -> parser function.
PARSERS: dict[int, Callable[[list[str]], Trade]] = {
    1: _parse_continuous_trade,
    3: _parse_premarket_summary,
}


# === Wire schema (Parquet column contract) ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
        pa.field("price", pa.int32()),
        pa.field("change_pct", pa.float32()),
        pa.field("qty", pa.int32()),
        pa.field("side", pa.int8()),
        pa.field("cum_vol", pa.int64()),
        pa.field("cum_trades", pa.int32()),
        pa.field("low_so_far", pa.int32()),
        pa.field("high_so_far", pa.int32()),
        pa.field("net_pressure", pa.int64()),
        pa.field("unknown_14", pa.int32()),
        pa.field("unknown_16", pa.float32()),
        pa.field("unknown_17", pa.float32()),
        pa.field("unknown_18", pa.float32()),
    ]
)


# === Persist ===


def write_parquet(trades: Iterable[Trade], path: Path) -> None:
    rows = sorted(trades, key=lambda t: t.ts_ms)
    cols = {
        field.name: pa.array([getattr(t, field.name) for t in rows], type=field.type)
        for field in PARQUET_SCHEMA
    }
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


# === Within-table invariants ===


class TradeValidationError(ValueError):
    """A trades-table invariant was violated (e.g. cum_vol regressed)."""


@dataclass(frozen=True)
class CumVolViolation:
    """One cum_vol regression found by ``find_cum_vol_violations``.

    index    -- position in the sorted continuous-trade list
    prev_cum -- preceding row's cum_vol
    curr_cum -- offending row's cum_vol (curr_cum < prev_cum)
    ts_ms    -- offending row's ts_ms (for diagnostic context)
    """
    index: int
    prev_cum: int
    curr_cum: int
    ts_ms: int


def find_cum_vol_violations(trades: list[Trade]) -> list[CumVolViolation]:
    """Pure: returns every cum_vol regression in continuous-trade rows
    (``side != 0``), sorted by ``(ts_ms, seq)``. Auction Cross rows
    (``side == 0``) carry ``cum_vol = 0`` and are excluded — their volume
    folds into the next continuous trade.

    Used by:
      - :func:`validate` (strict mode raises on first violation)
      - ``hoga.api.invariants.SERIES_INVARIANTS``'s ``series.cum_vol_monotonic``
        (returns full list for the wire / archival).
    """
    # Tie-break by seq for same-ms rows: ts_ms has ms precision, but seq is
    # strictly increasing per CONTEXT.md and reflects actual trade order. Without
    # the secondary key, sort stability hands order to dedup-insertion order,
    # which can re-order same-ms trades and falsely flag cum_vol regressions.
    sorted_trades = sorted(
        (t for t in trades if t.side != 0),
        key=lambda t: (t.ts_ms, t.seq),
    )
    out: list[CumVolViolation] = []
    prev = -1
    for i, t in enumerate(sorted_trades):
        if t.cum_vol < prev:
            out.append(CumVolViolation(
                index=i, prev_cum=prev, curr_cum=t.cum_vol, ts_ms=t.ts_ms,
            ))
        prev = t.cum_vol
    return out


def validate(trades: list[Trade], *, lenient: bool = False) -> None:
    """Check trades-table invariants.

    Invariant: ``cum_vol`` is non-decreasing across continuous-trading rows
    (``side != 0``) ordered by ``ts_ms``. Auction Cross rows (``side == 0``)
    carry ``cum_vol = 0`` and are excluded — their volume folds into the next
    continuous trade.

    In strict mode (default) raises ``TradeValidationError`` on first violation.
    In lenient mode skips violations silently (caller is responsible for noting
    the data may be imperfect).

    Delegates the actual scan to :func:`find_cum_vol_violations` so the same
    logic feeds the series-level invariants catalog without duplication.
    """
    violations = find_cum_vol_violations(trades)
    if violations and not lenient:
        first = violations[0]
        raise TradeValidationError(
            f"cum_vol decreased at ts_ms={first.ts_ms}: "
            f"{first.prev_cum} -> {first.curr_cum}"
        )


# === Query helpers (return native-time rows; callers own time/wire conversion) ===


@dataclass(frozen=True)
class FillStrengthRow:
    """One bucketed buy/sell-pressure row from :func:`query_fill_strength`.

    ``bucket_intra_ms`` is bucket-aligned LINEAR ms-from-midnight (NOT raw
    HHMMSSmmm and NOT Unix ms). The caller converts it to Unix ms via
    ``hoga.api.timeenc.ms_from_midnight_to_unix_ms(date, bucket_intra_ms)`` —
    the conversion needs the Stock-Date, which this table-level query does not
    take, so it stays the caller's responsibility (mirrors how candles.query_all
    returns native ts_ms and bundle re-bases it). ``buy_qty`` / ``sell_qty`` are
    positive magnitudes (sign lives in the source ``side`` column, not here).
    """

    bucket_intra_ms: int
    buy_qty: int
    sell_qty: int


def query_fill_strength(
    con: duckdb.DuckDBPyConnection, *, path: Path, bucket_ms: int
) -> list[FillStrengthRow]:
    """Aggregate continuous trades into per-bucket buy/sell quantities.

    Buckets on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding
    is non-linear (jumps at minute / hour boundaries), so arithmetic bucketing
    of HHMMSSmmm produces out-of-order ghost times — e.g. a raw 11:00:59.000
    bucketed via ``(ts_ms // 60000) * 60000`` decoded back to an earlier wall
    time. Decoding to linear ms BEFORE bucketing (via hhmmssms_to_intra_ms_sql)
    yields strictly ascending, distinct buckets. See hhmmssms_to_intra_ms_sql.

    Auction Cross / premarket rows (``side == 0``) are excluded (``WHERE side
    != 0``) — only aggressor-signed continuous trades count toward fill strength.

    Returns rows in ascending ``bucket_intra_ms`` order. Empty parquet → [].
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    rows = con.execute(
        f"""
        SELECT (({intra_ms_expr} // {bucket_ms}) * {bucket_ms}) AS bucket,
               SUM(CASE WHEN side = 1 THEN qty ELSE 0 END) AS buy_qty,
               SUM(CASE WHEN side = -1 THEN qty ELSE 0 END) AS sell_qty
        FROM read_parquet(?)
        WHERE side != 0
        GROUP BY 1 ORDER BY 1
        """,
        [str(path)],
    ).fetchall()
    return [
        FillStrengthRow(bucket_intra_ms=int(r[0]), buy_qty=int(r[1]), sell_qty=int(r[2]))
        for r in rows
    ]
