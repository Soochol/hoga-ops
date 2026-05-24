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
import pyarrow.parquet as pq
from pydantic import BaseModel

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
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


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


# === API representation (wire format for clients; excludes forensic fields) ===


class ApiTrade(BaseModel):
    ts_ms: int
    seq: int
    price: int
    change_pct: float
    qty: int
    side: int  # -1, 0, +1
    cum_vol: int
    cum_trades: int
    low_so_far: int
    high_so_far: int
    net_pressure: int


# === Query (returns ApiTrade directly — no intermediate dict) ===


_QUERY_COLS = (
    "ts_ms",
    "seq",
    "price",
    "change_pct",
    "qty",
    "side",
    "cum_vol",
    "cum_trades",
    "low_so_far",
    "high_so_far",
    "net_pressure",
)
_SELECT = ", ".join(_QUERY_COLS)


def _row_to_api(r: tuple) -> ApiTrade:
    return ApiTrade(
        ts_ms=r[0],
        seq=r[1],
        price=r[2],
        change_pct=r[3],
        qty=r[4],
        side=r[5],
        cum_vol=r[6],
        cum_trades=r[7],
        low_so_far=r[8],
        high_so_far=r[9],
        net_pressure=r[10],
    )


def query_up_to(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int, limit: int
) -> list[ApiTrade]:
    rows = con.execute(
        f"SELECT {_SELECT} FROM read_parquet(?) WHERE ts_ms <= ? ORDER BY ts_ms DESC LIMIT ?",
        [str(path), t_ms, limit],
    ).fetchall()
    return [_row_to_api(r) for r in rows]


def query_range(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    from_ms: int,
    to_ms: int,
    limit: int,
) -> list[ApiTrade]:
    rows = con.execute(
        f"SELECT {_SELECT} FROM read_parquet(?) WHERE ts_ms >= ? AND ts_ms <= ? "
        "ORDER BY ts_ms DESC LIMIT ?",
        [str(path), from_ms, to_ms, limit],
    ).fetchall()
    return [_row_to_api(r) for r in rows]
