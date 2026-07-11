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
import polars as pl
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


def write_parquet_frame(df: pl.DataFrame, path: Path) -> None:
    """write_parquet의 컬럼형 등가물 — dataclass getattr 물질화 없이 기록.

    정렬은 리스트 경로와 동일하게 ts_ms 단독 + stable(동일 ts는 입력 순서 보존).
    스키마 캐스팅은 PARQUET_SCHEMA로 다운캐스트(i64→i32 등) — 리스트 경로의
    pa.array(type=...) 캐스트와 동일 결과."""
    table = (
        df.sort("ts_ms", maintain_order=True)
        .select([f.name for f in PARQUET_SCHEMA])
        .to_arrow()
        .cast(PARQUET_SCHEMA)
    )
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, table)


def dedup_overlap_resends_frame(df: pl.DataFrame) -> pl.DataFrame:
    """dedup_overlap_resends의 컬럼형 등가물 — 입력 행 순서 보존.

    연속체결(side!=0, qty>0)에서 같은 cum_vol의 최대 seq만 생존, 나머지 행은
    무조건 보존 — 리스트 경로와 동일한 keep-LAST 규칙."""
    in_scope = (pl.col("side") != 0) & (pl.col("qty") > 0)
    keep_last = (
        df.filter(in_scope)
        .group_by("cum_vol")
        .agg(pl.col("seq").max().alias("_keep_seq"))
    )
    return (
        df.with_row_index("_ord")
        .join(keep_last, on="cum_vol", how="left")
        .filter(~in_scope | (pl.col("seq") == pl.col("_keep_seq")))
        .sort("_ord")
        .drop("_ord", "_keep_seq")
    )


def find_cum_vol_violations_frame(df: pl.DataFrame) -> list[CumVolViolation]:
    """find_cum_vol_violations의 컬럼형 등가물 — 동일 (index, prev, curr, ts_ms)."""
    s = df.filter(pl.col("side") != 0).sort(["ts_ms", "seq"])
    if s.height == 0:
        return []
    s = s.with_row_index("_i").with_columns(
        pl.col("cum_vol").shift(1, fill_value=-1).alias("_prev"),
    )
    bad = s.filter(pl.col("cum_vol") < pl.col("_prev"))
    return [
        CumVolViolation(
            index=int(r["_i"]), prev_cum=int(r["_prev"]),
            curr_cum=int(r["cum_vol"]), ts_ms=int(r["ts_ms"]),
        )
        for r in bad.select("_i", "_prev", "cum_vol", "ts_ms").to_dicts()
    ]


def validate_frame(df: pl.DataFrame, *, lenient: bool = False) -> None:
    """validate의 컬럼형 등가물 — 동일 예외 클래스·메시지."""
    violations = find_cum_vol_violations_frame(df)
    if violations and not lenient:
        first = violations[0]
        raise TradeValidationError(
            f"cum_vol decreased at ts_ms={first.ts_ms}: "
            f"{first.prev_cum} -> {first.curr_cum}"
        )


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


def dedup_overlap_resends(trades: list[Trade]) -> list[Trade]:
    """Drop hogaplay page re-send duplicates among continuous trades.

    hogaplay occasionally re-sends an overlapping trade page with FRESH ``seq``
    numbers (and slightly shifted ``ts_ms``), so the parser's seq-dedup
    (:func:`_collect_events`) lets both copies through. The re-send surfaces as a
    ``cum_vol`` regression — the later copy restarts at a lower cum_vol than the
    first copy's tail and re-traverses the same values — which trips
    ``series.cum_vol_monotonic`` and double-counts the repeated rows' ``qty`` in
    the 체결강도 (fill-strength) bucket they land in.

    Rule (verified 2026-06-08 against all 67 affected Stock-Dates): for
    continuous trades (``side != 0``, ``qty > 0``) ``cum_vol`` is the exchange's
    strictly-increasing cumulative volume, so it is a UNIQUE per-trade key — a
    repeated cum_vol can only be a re-sent copy. Keep the LAST occurrence (max
    ``seq``) and drop earlier copies: a page re-send carries the rows in the
    order that restores cum_vol monotonicity under an (ts_ms, seq) sort, so
    keep-LAST clears the regression where keep-FIRST does not.

    Scope guards (both load-bearing):
      - ``side == 0`` (Auction Cross) rows carry ``cum_vol = 0`` and legitimately
        share it — NEVER deduped here.
      - ``qty == 0`` continuous rows would not increment cum_vol, so cum_vol
        would no longer be unique among them — excluded from the key and kept
        as-is. (No such rows exist in the current corpus; this is defensive.)

    Pure: returns the input list minus dropped earlier-copies, original order
    preserved. A clean Stock-Date (no repeated cum_vol) is returned unchanged.
    """
    max_seq_by_cum: dict[int, int] = {}
    for t in trades:
        if t.side != 0 and t.qty > 0:
            cur = max_seq_by_cum.get(t.cum_vol)
            if cur is None or t.seq > cur:
                max_seq_by_cum[t.cum_vol] = t.seq
    out: list[Trade] = []
    for t in trades:
        if t.side == 0 or t.qty == 0:
            out.append(t)
        elif t.seq == max_seq_by_cum[t.cum_vol]:
            out.append(t)
        # else: an earlier-seq copy of a re-sent cum_vol — drop it.
    return out


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


@dataclass(frozen=True)
class TradeVolumePocRow:
    """One date's most-traded regular-session price area.

    ``*_price`` are the selected distribution-bin boundaries and midpoint.
    ``intra_ms`` is the first linear ms-from-midnight trade in that bin.
    """

    center_price: int
    low_price: int
    high_price: int
    qty: int
    intra_ms: int


def _hhmmssms_to_intra_ms(value: int) -> int:
    h = value // 10_000_000
    m = (value // 100_000) % 100
    s = (value // 1000) % 100
    ms = value % 1000
    return h * 3_600_000 + m * 60_000 + s * 1000 + ms


def _session_bound_to_intra_ms(value: int) -> int:
    return _hhmmssms_to_intra_ms(value) if value > 86_400_000 else value


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


def query_trade_volume_poc(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    price_lo: int,
    price_hi: int,
    bins: int,
    session_open_ms: int,
    session_close_ms: int,
    continuous_before_ms: int | None = None,
) -> TradeVolumePocRow | None:
    """Return the strongest regular-session distribution bin for a day.

    Regular-session means side +/-1 trades inside ``[session_open_ms,
    session_close_ms)`` after decoding native HHMMSSmmm to linear
    ms-from-midnight. side=0 is excluded so auction/single-price prints do not
    dominate the bin.
    """
    bin_width = (price_hi - price_lo) / bins
    if bin_width <= 0:
        bin_width = 1
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    session_open_intra_ms = _session_bound_to_intra_ms(session_open_ms)
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    upper_bound_intra_ms = (
        _session_bound_to_intra_ms(continuous_before_ms)
        if continuous_before_ms is not None
        else session_close_intra_ms
    )
    rows = con.execute(
        f"""
        WITH regular AS (
          SELECT price,
                 qty,
                 {intra_ms_expr} AS intra_ms
          FROM read_parquet(?)
          WHERE side IN (1, -1)
            AND price > 0
            AND qty > 0
        )
        SELECT GREATEST(0, LEAST(?, FLOOR((price - ?) / ?)::BIGINT)) AS bin_idx,
               SUM(qty) AS qty,
               MIN(intra_ms) AS first_intra_ms
        FROM regular
        WHERE intra_ms >= ? AND intra_ms < ?
          AND price BETWEEN ? AND ?
        GROUP BY 1
        ORDER BY bin_idx ASC
        """,
        [
            str(path),
            bins - 1,
            price_lo,
            bin_width,
            session_open_intra_ms,
            upper_bound_intra_ms,
            price_lo,
            price_hi,
        ],
    ).fetchall()
    if not rows:
        return None

    best: tuple[int, int, int, int, int, int] | None = None
    for order, (bin_idx_raw, qty_raw, first_intra_ms_raw) in enumerate(rows):
        bin_idx = max(0, min(bins - 1, int(bin_idx_raw)))
        low_price = int(price_lo + bin_idx * bin_width)
        high_price = int(price_hi if bin_idx == bins - 1 else price_lo + (bin_idx + 1) * bin_width)
        center_price = int((low_price + high_price) // 2)
        qty = int(qty_raw)
        first_intra_ms = int(first_intra_ms_raw)
        candidate = (qty, -order, center_price, low_price, high_price, first_intra_ms)
        if best is None or candidate > best:
            best = candidate

    assert best is not None
    qty, _neg_order, center_price, low_price, high_price, first_intra_ms = best
    return TradeVolumePocRow(
        center_price=center_price,
        low_price=low_price,
        high_price=high_price,
        qty=qty,
        intra_ms=first_intra_ms,
    )


@dataclass(frozen=True)
class VolumeProfileBinning:
    """Result of the price-binned quantity query
    (:func:`query_continuous_trade_volume_distribution`) — the price range plus
    the sparse per-bin quantities. (mode=full 퇴역으로 volume-profile 쿼리 2종은
    2026-07-08 삭제; 이 타입은 매물대 분포 쿼리가 계속 사용한다.)

    ``bins`` is sparse: ``list[(bin_idx, qty)]`` straight from the GROUP BY, in
    ascending bin_idx order. ``bin_idx`` may equal ``vp_bins`` at the upper edge
    (FLOOR of the max price lands one past the last valid index); the caller
    clamps this top-edge row into ``vp_bins-1`` (the last bin) when expanding
    into a dense bin array — so price_max volume is never dropped. Returning
    sparse rows + the range (not a wire ``VolumeProfile``) keeps this module
    free of any ``hoga.api.models`` dependency (ADR-0001: tables don't import
    wire models).

    ``bin_width`` is the RAW float bin width (geometric truth). It is
    deliberately NOT truncated here: callers compute each bin's ``price_low`` as
    ``int(price_min + idx * bin_width)`` using this float, and only truncate to
    int for the wire value — truncating earlier would shift ``price_low`` for
    fractional bin widths. Both producing queries floor ``bin_width`` at 1.0
    for a zero-width (single-price) range to prevent a divide-by-zero in SQL.
    """

    price_min: int
    price_max: int
    bin_width: float
    bins: list[tuple[int, int]]
    max_intra_ms: int | None = None


def query_continuous_trade_volume_distribution(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    price_lo: int,
    price_hi: int,
    bins: int,
    session_open_ms: int,
    session_close_ms: int,
    upper_bound_ms: int | None = None,
    continuous_before_ms: int | None = None,
) -> VolumeProfileBinning:
    """Bin continuous-trading qty into a caller-supplied candle price range.

    Unlike the retired all-side volume-profile query, this excludes Auction
    Cross rows (side=0) and bounds rows to the Stock-Date session after
    decoding HHMMSSmmm into linear ms-from-midnight.
    """
    bin_width = (price_hi - price_lo) / bins
    if bin_width <= 0:
        bin_width = 1
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    session_open_intra_ms = _session_bound_to_intra_ms(session_open_ms)
    session_close_intra_ms = _session_bound_to_intra_ms(session_close_ms)
    structural_upper_intra_ms = (
        _session_bound_to_intra_ms(continuous_before_ms)
        if continuous_before_ms is not None
        else None
    )
    effective_upper_intra_ms = min(
        bound
        for bound in (session_close_intra_ms, upper_bound_ms, structural_upper_intra_ms)
        if bound is not None
    )
    rows = con.execute(
        f"""
        WITH continuous AS (
          SELECT price,
                 qty,
                 {intra_ms_expr} AS intra_ms
          FROM read_parquet(?)
          WHERE side IN (1, -1)
            AND price > 0
            AND qty > 0
        ),
        filtered AS (
          SELECT price, qty, intra_ms
          FROM continuous
          WHERE intra_ms >= ?
            AND intra_ms < ?
            AND price BETWEEN {price_lo} AND {price_hi}
        ),
        stats AS (
          SELECT MAX(intra_ms) AS max_intra_ms FROM filtered
        )
        SELECT FLOOR((price - {price_lo}) / {bin_width})::BIGINT AS bin_idx,
               SUM(qty) AS qty,
               stats.max_intra_ms
        FROM filtered, stats
        GROUP BY 1, 3 ORDER BY 1
        """,
        [str(path), session_open_intra_ms, effective_upper_intra_ms],
    ).fetchall()
    return VolumeProfileBinning(
        price_min=price_lo,
        price_max=price_hi,
        bin_width=float(bin_width),
        bins=[(int(idx), int(qty)) for idx, qty, _max_intra_ms in rows],
        max_intra_ms=int(rows[0][2]) if rows and rows[0][2] is not None else None,
    )
