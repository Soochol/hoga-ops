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


@dataclass(frozen=True)
class VolumeProfileBinning:
    """Result of the volume-profile binning queries (:func:`query_volume_profile`
    and :func:`query_volume_profile_range`) — the price range plus the sparse
    per-bin quantities.

    ``bins`` is sparse: ``list[(bin_idx, qty)]`` straight from the GROUP BY, in
    ascending bin_idx order. ``bin_idx`` may fall outside ``[0, vp_bins)`` at the
    upper edge (FLOOR of the max price); the caller is responsible for clamping
    when it expands these into a dense bin array. Returning sparse rows + the
    range (not a wire ``VolumeProfile``) keeps this module free of any
    ``hoga.api.models`` dependency (ADR-0001: tables don't import wire models).

    ``bin_width`` is the RAW float bin width (geometric truth). It is
    deliberately NOT truncated here: callers compute each bin's ``price_low`` as
    ``int(price_min + idx * bin_width)`` using this float, and only truncate to
    int for the wire value — truncating earlier would shift ``price_low`` for
    fractional bin widths. Each producing query documents its own zero-width
    policy (the range query floors at 1.0; the per-slice query does not).
    """

    price_min: int
    price_max: int
    bin_width: float
    bins: list[tuple[int, int]]


def query_volume_profile_range(
    con: duckdb.DuckDBPyConnection, *, paths: list[str], vp_bins: int = 24
) -> VolumeProfileBinning | None:
    """Union ``paths`` (multi-file ``read_parquet`` via a list parameter) into one
    price-binned volume profile over the unioned ``MIN(price)..MAX(price)`` range.

    No side filter — auction crosses (``side == 0``) count toward the volume
    profile per spec §4.1. The path is parameter-bound (list) for the multi-file
    glob; the bin arithmetic is f-string'd because price_min / bin_width are
    server-derived numerics.

    Returns ``None`` when the union has no priced rows (``MIN/MAX`` is NULL) so
    the caller can map that to an empty profile. ``bin_width`` is floored at 1
    for a single-price range (guards ZeroDivision).
    """
    min_max = con.execute(
        "SELECT MIN(price), MAX(price) FROM read_parquet(?)", [paths],
    ).fetchone()
    if min_max is None or min_max[0] is None:
        return None
    price_min, price_max = int(min_max[0]), int(min_max[1])

    # Bin-width derived from vp_bins. Guard against zero-width range
    # (single-price day) by flooring at 1.
    bin_width_raw = (price_max - price_min) / vp_bins if vp_bins > 0 else 1
    if bin_width_raw <= 0:
        bin_width_raw = 1

    rows = con.execute(
        f"""
        SELECT FLOOR((price - {price_min}) / {bin_width_raw})::BIGINT AS bin_idx,
               SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_min} AND {price_max}
        GROUP BY 1 ORDER BY 1
        """,
        [paths],
    ).fetchall()
    return VolumeProfileBinning(
        price_min=price_min,
        price_max=price_max,
        bin_width=float(bin_width_raw),
        bins=[(int(idx), int(qty)) for idx, qty in rows],
    )


def query_volume_profile(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    price_lo: int,
    price_hi: int,
    bins: int = 24,
) -> VolumeProfileBinning:
    """Bin one trades.parquet's price/qty within the caller-supplied
    ``[price_lo, price_hi]`` range.

    Cross-table by design: the range comes from the candles dimension
    (``candles.query_price_range``), derived and passed in by the caller (the
    range bundle), so this stays a single-table trades query. No side filter —
    auction crosses (``side == 0``) count toward the volume profile per spec
    §4.1.

    Unlike :func:`query_volume_profile_range`, this has NO zero-width guard: if
    ``price_lo == price_hi`` the bin width is 0 and the binning SQL divides by
    zero — preserved as the pre-existing behavior of build_volume_profile_slice
    (the caller's candle range is non-degenerate in practice). ``bin_width`` is
    returned as the RAW float; the caller truncates for the wire value (see
    :class:`VolumeProfileBinning`).
    """
    bin_width = (price_hi - price_lo) / bins
    rows = con.execute(
        f"""
        SELECT FLOOR((price - {price_lo}) / {bin_width})::BIGINT AS bin_idx,
               SUM(qty) AS qty
        FROM read_parquet(?)
        WHERE price BETWEEN {price_lo} AND {price_hi}
        GROUP BY 1 ORDER BY 1
        """,
        [str(path)],
    ).fetchall()
    return VolumeProfileBinning(
        price_min=price_lo,
        price_max=price_hi,
        bin_width=float(bin_width),
        bins=[(int(idx), int(qty)) for idx, qty in rows],
    )
