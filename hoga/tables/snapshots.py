"""Snapshots table — 10-level orderbook state.

Each event type 2 row is a full state snapshot. In-memory the entity uses
10-tuples for price/qty/delta arrays; on disk those are flattened into
``ask_p1..ask_p10``, ``ask_q1..ask_q10``, ``ask_d1..ask_d10`` etc. columns.
"""

from __future__ import annotations

from bisect import bisect_right
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

from hoga.api.timeenc import hhmmssms_to_intra_ms_sql

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


def _parquet_has_column(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    column_name: str,
) -> bool:
    row = con.execute(
        "SELECT 1 FROM parquet_schema(?) WHERE name = ? LIMIT 1",
        [str(path), column_name],
    ).fetchone()
    return row is not None


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
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


def read_parquet(path: Path) -> list[Orderbook]:
    """Symmetric inverse of :func:`write_parquet` — reassembles ``Orderbook``
    tuple fields from the 60 flattened parquet columns.

    Lives here (not in callers like ``hoga/cli.py``'s ``_run_series_for``)
    because reading is the inverse of writing — both must agree on the
    flat schema (``ORDERBOOK_LEVELS`` × 6 prefixes + 4 totals), and the
    write_parquet ↔ read_parquet round-trip is the test surface for that
    schema. Callers staying outside the snapshots module would have to
    re-derive the schema and silently drift when it changes.
    """
    table = pq.read_table(path)
    rows = table.to_pylist()
    return [_row_to_orderbook(r) for r in rows]


def _row_to_orderbook(r: dict) -> Orderbook:
    def _tup(prefix: str) -> tuple[int, ...]:
        return tuple(r[f"{prefix}{i}"] for i in range(1, ORDERBOOK_LEVELS + 1))

    return Orderbook(
        ts_ms=r["ts_ms"], seq=r["seq"],
        ask_p=_tup("ask_p"), ask_q=_tup("ask_q"), ask_d=_tup("ask_d"),
        bid_p=_tup("bid_p"), bid_q=_tup("bid_q"), bid_d=_tup("bid_d"),
        tot_ask=r["tot_ask"], tot_ask_d=r["tot_ask_d"],
        tot_bid=r["tot_bid"], tot_bid_d=r["tot_bid_d"],
    )


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


class ApiOrderbookLevel(BaseModel):
    """One depth row on the wire. Index in the parent ``ask``/``bid`` list
    encodes rank (index 0 = best price)."""

    price: int
    qty: int


class ApiOrderbookSnapshot(BaseModel):
    """Wire Model — shape consumers (frontend, notebook clients) receive
    verbatim, per ADR-0004. Internal forensic columns (``ask_d``/``bid_d``
    delta volumes, ``tot_ask_d``/``tot_bid_d``) stay on the :class:`Orderbook`
    Entity / in Parquet but are not exposed here."""

    ts_ms: int
    seq: int
    ask: list[ApiOrderbookLevel]  # length 10, index 0 = best ask
    bid: list[ApiOrderbookLevel]  # length 10, index 0 = best bid
    tot_ask: int
    tot_bid: int


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


@dataclass(frozen=True)
class _SnapshotQueryIndex:
    mtime_ns: int
    size: int
    ts_values: tuple[int, ...]
    intra_values: tuple[int, ...]
    continuous_values: tuple[bool, ...]
    rows: tuple[tuple, ...]


_QUERY_AT_CACHE_MAX = 32
_query_at_cache: OrderedDict[str, _SnapshotQueryIndex] = OrderedDict()
_query_at_cache_lock = Lock()


def _load_query_index(path: Path) -> _SnapshotQueryIndex:
    stat = path.stat()
    key = str(path)
    with _query_at_cache_lock:
        cached = _query_at_cache.get(key)
        if (
            cached is not None
            and cached.mtime_ns == stat.st_mtime_ns
            and cached.size == stat.st_size
        ):
            _query_at_cache.move_to_end(key)
            return cached

    table = pq.read_table(path, columns=list(_QUERY_COLS))
    cols = [table.column(name).to_pylist() for name in _QUERY_COLS]
    rows = tuple(zip(*cols, strict=True))
    ts_values = tuple(row[0] for row in rows)
    intra_values = tuple(_hhmmssms_to_intra_ms(row[0]) for row in rows)
    continuous_values = tuple(
        sum(row[i] for i in _ASK_DEEP_Q_INDEXES) > 0
        and sum(row[i] for i in _BID_DEEP_Q_INDEXES) > 0
        for row in rows
    )
    index = _SnapshotQueryIndex(
        mtime_ns=stat.st_mtime_ns,
        size=stat.st_size,
        ts_values=ts_values,
        intra_values=intra_values,
        continuous_values=continuous_values,
        rows=rows,
    )

    with _query_at_cache_lock:
        _query_at_cache[key] = index
        _query_at_cache.move_to_end(key)
        while len(_query_at_cache) > _QUERY_AT_CACHE_MAX:
            _query_at_cache.popitem(last=False)
    return index


def _row_to_api_snapshot(row: tuple) -> ApiOrderbookSnapshot:
    """Unflatten a ``SELECT _SELECT`` row into an ApiOrderbookSnapshot. Shared by
    the point-in-time (`query_at`) and bucket-representative
    (`query_bucket_representative`) read paths so both agree on column order."""
    by_name = dict(zip(_QUERY_COLS, row, strict=True))
    return ApiOrderbookSnapshot(
        ts_ms=by_name["ts_ms"],
        seq=by_name["seq"],
        ask=[
            ApiOrderbookLevel(price=by_name[f"ask_p{i}"], qty=by_name[f"ask_q{i}"])
            for i in range(1, ORDERBOOK_LEVELS + 1)
        ],
        bid=[
            ApiOrderbookLevel(price=by_name[f"bid_p{i}"], qty=by_name[f"bid_q{i}"])
            for i in range(1, ORDERBOOK_LEVELS + 1)
        ],
        tot_ask=by_name["tot_ask"],
        tot_bid=by_name["tot_bid"],
    )


_REPRESENTATIVE_ORDER_SQL: str = "ts_ms DESC, seq DESC"


def _hhmmssms_to_intra_ms(ts_ms: int) -> int:
    return (
        (ts_ms // 10_000_000) * 3_600_000
        + ((ts_ms // 100_000) % 100) * 60_000
        + ((ts_ms // 1_000) % 100) * 1_000
        + (ts_ms % 1_000)
    )


def _is_continuous_snapshot(
    snapshot: ApiOrderbookSnapshot,
    *,
    last_continuous_ms: int | None,
) -> bool:
    if last_continuous_ms is not None and _hhmmssms_to_intra_ms(snapshot.ts_ms) > last_continuous_ms:
        return False
    ask_deep = sum(level.qty for level in snapshot.ask[_AUCTION_BOOK_DEPTH:])
    bid_deep = sum(level.qty for level in snapshot.bid[_AUCTION_BOOK_DEPTH:])
    return ask_deep > 0 and bid_deep > 0


def _last_continuous_intra_ms_from_index(
    index: _SnapshotQueryIndex,
    *,
    session_close_ms: int | None,
) -> int | None:
    if session_close_ms is None:
        return None
    close_intra_ms = _hhmmssms_to_intra_ms(int(session_close_ms))
    for intra_ms, is_continuous in zip(
        reversed(index.intra_values),
        reversed(index.continuous_values),
        strict=True,
    ):
        if is_continuous and intra_ms <= close_intra_ms:
            return intra_ms
    return None


def _row_is_representative_candidate(
    index: _SnapshotQueryIndex,
    pos: int,
    *,
    last_continuous_ms: int | None,
) -> bool:
    if not index.continuous_values[pos]:
        return False
    return last_continuous_ms is None or index.intra_values[pos] <= last_continuous_ms


def _continuous_representative_pred_sql(*, intra_ms_expr: str, last_continuous_ms: int | None) -> str:
    if last_continuous_ms is None:
        return _DEEP_BOOK_SQL
    return f"({_DEEP_BOOK_SQL} AND ({intra_ms_expr} <= {last_continuous_ms}))"


def query_at(
    con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int
) -> ApiOrderbookSnapshot | None:
    """Return the latest snapshot at ts_ms <= t_ms as an ApiOrderbookSnapshot, or None
    if before any data."""
    del con  # retained for the public table-query signature used by callers.
    index = _load_query_index(path)
    pos = bisect_right(index.ts_values, t_ms) - 1
    if pos < 0:
        return None
    row = index.rows[pos]
    return _row_to_api_snapshot(row) if row is not None else None


def query_time_bounds(con: duckdb.DuckDBPyConnection, *, path: Path) -> tuple[int, int] | None:
    """Return (min ts_ms, max ts_ms) across the snapshots, or None if empty."""
    row = con.execute("SELECT min(ts_ms), max(ts_ms) FROM read_parquet(?)", [str(path)]).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0]), int(row[1])


def _last_continuous_intra_ms(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    session_close_ms: int | None,
) -> int | None:
    if session_close_ms is None:
        return None
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
    row = con.execute(
        f"SELECT max({intra_ms_expr}) FROM read_parquet(?) "
        f"WHERE {_DEEP_BOOK_SQL} AND {intra_ms_expr} <= {close_intra_sql}",
        [str(path)],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0])


def query_first_trailing_single_price_book_intra_ms(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    session_close_ms: int | None,
) -> int | None:
    """Return the first shallow book after the final deep book before close."""
    if session_close_ms is None:
        return None
    last_continuous = _last_continuous_intra_ms(
        con,
        path=path,
        session_close_ms=session_close_ms,
    )
    if last_continuous is None:
        return None
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
    row = con.execute(
        f"SELECT min({intra_ms_expr}) FROM read_parquet(?) "
        f"WHERE NOT ({_DEEP_BOOK_SQL}) "
        f"AND {intra_ms_expr} > ? "
        f"AND {intra_ms_expr} <= {close_intra_sql}",
        [str(path), last_continuous],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return int(row[0])


def query_first_ts(con: duckdb.DuckDBPyConnection, *, path: Path) -> int | None:
    """Return min ts_ms or None."""
    bounds = query_time_bounds(con, path=path)
    return bounds[0] if bounds else None


# === Bucketed depth-ratio query (native-time rows; caller owns time/wire conv) ===


_ASK_Q_SUM: str = " + ".join(f"ask_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1))
_BID_Q_SUM: str = " + ".join(f"bid_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1))

# Single-price auction is detected by orderbook STRUCTURE, not a 15:20 clock
# (ADR-0062). KRX single-price phases (closing auction, intraday VI) expose exactly
# the top 3 levels per side; a continuous-trading book still has depth beyond level
# 3 on both sides. _ASK_DEEP_SUM / _BID_DEEP_SUM sum the deep (level 4..10) columns so
# query_bucketed_ratio can test "is this a continuous-trading book?".
_AUCTION_BOOK_DEPTH: int = 3
_ASK_DEEP_SUM: str = " + ".join(
    f"ask_q{i}" for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
)
_BID_DEEP_SUM: str = " + ".join(
    f"bid_q{i}" for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
)

# 연속거래 호가창 술어 — query_bucketed_ratio의 deep_book_sql과 동일(단일진실원).
# 클라 isContinuousBook(bucketHogaSeries.ts)과도 글자 그대로 같은 정의.
_DEEP_BOOK_SQL: str = f"(({_ASK_DEEP_SUM}) > 0 AND ({_BID_DEEP_SUM}) > 0)"
_ASK_DEEP_Q_INDEXES: tuple[int, ...] = tuple(
    _QUERY_COLS.index(f"ask_q{i}")
    for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
)
_BID_DEEP_Q_INDEXES: tuple[int, ...] = tuple(
    _QUERY_COLS.index(f"bid_q{i}")
    for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
)


@dataclass(frozen=True)
class QuoteRatioRow:
    """One bucketed bid/ask depth-total row from :func:`query_bucketed_ratio`.

    ``bucket_intra_ms`` is bucket-aligned LINEAR ms-from-midnight (NOT raw
    HHMMSSmmm and NOT Unix ms). The caller converts via
    ``hoga.api.timeenc.ms_from_midnight_to_unix_ms(date, bucket_intra_ms)`` —
    the conversion needs the Stock-Date, which this table-level query does not
    take. ``ask_total`` / ``bid_total`` are the SUM of the 10 ask_q / bid_q
    level columns at the last snapshot in the bucket.

    Intra-Bar Max 필드(ADR-0076): ``bid_max`` / ``ask_max`` = 버킷 내 연속거래
    스냅샷의 bid_total / ask_total 독립 최댓값. ``imb_max_bid`` / ``imb_max_ask``
    = 버킷 내 |imbalance|(= GREATEST/LEAST ratio 단조 대용)가 가장 컸던 연속거래
    스냅샷의 (bid_total, ask_total) 쌍. 동시호가/완전-auction 버킷은 4필드 모두 0.
    """

    bucket_intra_ms: int
    bid_total: int
    ask_total: int
    bid_max: int
    ask_max: int
    imb_max_bid: int
    imb_max_ask: int


@dataclass(frozen=True)
class AskPeakRow:
    """당일 연속거래 중 단일 매도 호가단계에 걸린 최대 물량과 가격.

    ``intra_ms``는 LINEAR ms-from-midnight(NOT raw HHMMSSmmm, NOT unix ms) —
    호출자가 ``ms_from_midnight_to_unix_ms(date, intra_ms)``로 unix 변환.
    QuoteRatioRow.bucket_intra_ms와 동일 규약.

    ``price``/``qty``/``intra_ms`` = 버킷 대표(마지막 연속거래 스냅샷)의
    당일 매도벽 최댓값(#96 close 변종). ``max_*`` = 버킷 대표를 거치지 않고
    연속거래 스냅샷 전체에서 찾은 단일 매도단계 당일 max(Intra-Bar Max, ADR-0076).
    """
    price: int
    qty: int
    intra_ms: int
    max_price: int
    max_qty: int
    max_intra_ms: int


@dataclass(frozen=True)
class AskPeakCandidateRow:
    price: int
    qty: int
    intra_ms: int


@dataclass(frozen=True)
class _PeakWallEvent:
    side: str
    source: str
    price: int
    qty: int
    intra_ms: int
    ts_ms: int
    seq: int
    bucket_id: int | None


@dataclass(frozen=True)
class _TradeTouch:
    price: int
    ts_ms: int
    seq: int
    side: int = 1


@dataclass(frozen=True)
class _ClassifiedPeakWalls:
    traded: tuple[AskPeakCandidateRow, ...]
    untraded: tuple[AskPeakCandidateRow, ...]
    all: tuple[AskPeakCandidateRow, ...]


def _event_sort_key(event: _PeakWallEvent) -> tuple[int, int, str, int]:
    return (event.ts_ms, event.seq, event.source, event.price)


def _touch_sort_key(touch: _TradeTouch) -> tuple[int, int]:
    return (touch.ts_ms, touch.seq)


def _candidate_sort_key(row: AskPeakCandidateRow) -> tuple[int, int, int]:
    return (-row.qty, row.intra_ms, row.price)


def _better_event(current: _PeakWallEvent | None, event: _PeakWallEvent) -> _PeakWallEvent:
    if current is None:
        return event
    current_key = (-current.qty, current.intra_ms, current.seq, current.price)
    event_key = (-event.qty, event.intra_ms, event.seq, event.price)
    return event if event_key < current_key else current


def _event_to_candidate(event: _PeakWallEvent) -> AskPeakCandidateRow:
    return AskPeakCandidateRow(price=event.price, qty=event.qty, intra_ms=event.intra_ms)


def _touches_price(side: Literal["ask", "bid"], touch_price: int, wall_price: int) -> bool:
    return touch_price >= wall_price if side == "ask" else touch_price <= wall_price


def _classify_peak_wall_events(
    events: Iterable[_PeakWallEvent],
    touches: Iterable[_TradeTouch],
    *,
    side: Literal["ask", "bid"],
    emit_limit: int = 3,
) -> _ClassifiedPeakWalls:
    emit_limit = max(0, min(int(emit_limit), 3))
    sorted_events = sorted(events, key=_event_sort_key)
    sorted_touches = sorted(touches, key=_touch_sort_key)

    active_by_price: dict[int, _PeakWallEvent] = {}
    all_best_by_bucket: dict[tuple[int, int | None], _PeakWallEvent] = {}
    traded_events: list[_PeakWallEvent] = []
    event_i = 0

    for touch in sorted_touches:
        while event_i < len(sorted_events):
            event = sorted_events[event_i]
            if event.ts_ms > touch.ts_ms or (event.ts_ms == touch.ts_ms and event.seq > touch.seq):
                break
            if event.side != side:
                event_i += 1
                continue
            active_by_price[event.price] = _better_event(active_by_price.get(event.price), event)
            bucket_key = (event.price, event.bucket_id)
            all_best_by_bucket[bucket_key] = _better_event(
                all_best_by_bucket.get(bucket_key),
                event,
            )
            event_i += 1

        touched_prices = [
            price
            for price in active_by_price
            if touch.side in (1, -1) and _touches_price(side, touch.price, price)
        ]
        for price in touched_prices:
            traded_events.append(active_by_price.pop(price))

    for event in sorted_events[event_i:]:
        if event.side != side:
            continue
        active_by_price[event.price] = _better_event(active_by_price.get(event.price), event)
        bucket_key = (event.price, event.bucket_id)
        all_best_by_bucket[bucket_key] = _better_event(
            all_best_by_bucket.get(bucket_key),
            event,
        )

    candidate_rows = [_event_to_candidate(event) for event in traded_events]
    traded = tuple(
        row
        for row in sorted(candidate_rows, key=_candidate_sort_key)
    )[:emit_limit]
    candidate_rows = [_event_to_candidate(event) for event in active_by_price.values()]
    untraded = tuple(
        row
        for row in sorted(candidate_rows, key=_candidate_sort_key)
    )[:emit_limit]
    candidate_rows = [_event_to_candidate(event) for event in all_best_by_bucket.values()]
    all_candidates = tuple(
        row
        for row in sorted(candidate_rows, key=_candidate_sort_key)
    )[:emit_limit]
    return _ClassifiedPeakWalls(traded=traded, untraded=untraded, all=all_candidates)


@dataclass(frozen=True)
class AskPeakDualRow:
    """Day ask peak split into post-touch, all-level, and post-untouched views.

    ``price``/``qty``/``intra_ms`` and ``max_*`` are the legacy rank-1 carriers
    for post-touch ask events and stay ``None`` when no post-touch candidate
    exists. ``all_*`` fields use every eligible ask level regardless of touch
    state. ``untraded_*`` is the legacy rank-1 wire for post-untouched asks,
    while ``untraded_*_peaks`` preserves the full ranked candidates array. All
    variants share the same continuous-book/session filters.
    """
    price: int | None
    qty: int | None
    intra_ms: int | None
    max_price: int | None
    max_qty: int | None
    max_intra_ms: int | None
    traded_peaks: tuple[AskPeakCandidateRow, ...]
    traded_max_peaks: tuple[AskPeakCandidateRow, ...]
    all_price: int
    all_qty: int
    all_intra_ms: int
    all_max_price: int
    all_max_qty: int
    all_max_intra_ms: int
    all_peaks: tuple[AskPeakCandidateRow, ...] = ()
    all_max_peaks: tuple[AskPeakCandidateRow, ...] = ()
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_intra_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_intra_ms: int | None = None
    untraded_peaks: tuple[AskPeakCandidateRow, ...] = ()
    untraded_max_peaks: tuple[AskPeakCandidateRow, ...] = ()


@dataclass(frozen=True)
class BidPeakRow:
    """당일 연속거래 중 단일 매수 호가단계에 걸린 최대 물량과 가격.

    ``intra_ms``는 LINEAR ms-from-midnight(NOT raw HHMMSSmmm, NOT unix ms) -
    호출자가 ``ms_from_midnight_to_unix_ms(date, intra_ms)``로 unix 변환.
    QuoteRatioRow.bucket_intra_ms와 동일 규약.

    ``price``/``qty``/``intra_ms`` = 버킷 대표(마지막 연속거래 스냅샷)의
    당일 매수벽 최댓값(#96 close 변종). ``max_*`` = 버킷 대표를 거치지 않고
    연속거래 스냅샷 전체에서 찾은 단일 매수단계 당일 max(Intra-Bar Max, ADR-0076).
    """
    price: int
    qty: int
    intra_ms: int
    max_price: int
    max_qty: int
    max_intra_ms: int


@dataclass(frozen=True)
class BidPeakDualRow:
    """Day bid peak split into post-touch, all-level, and post-untouched views.

    ``price``/``qty``/``intra_ms`` and ``max_*`` are the legacy rank-1 carriers
    for post-touch bid events and stay ``None`` when no post-touch candidate
    exists. ``all_*`` fields use every eligible bid level regardless of touch
    state. ``untraded_*`` is the legacy rank-1 wire for post-untouched bids,
    while ``untraded_*_peaks`` preserves the full ranked candidates array. All
    variants share the same continuous-book/session filters.
    """
    price: int | None
    qty: int | None
    intra_ms: int | None
    max_price: int | None
    max_qty: int | None
    max_intra_ms: int | None
    traded_peaks: tuple[AskPeakCandidateRow, ...]
    traded_max_peaks: tuple[AskPeakCandidateRow, ...]
    all_price: int
    all_qty: int
    all_intra_ms: int
    all_max_price: int
    all_max_qty: int
    all_max_intra_ms: int
    all_peaks: tuple[AskPeakCandidateRow, ...] = ()
    all_max_peaks: tuple[AskPeakCandidateRow, ...] = ()
    untraded_price: int | None = None
    untraded_qty: int | None = None
    untraded_intra_ms: int | None = None
    untraded_max_price: int | None = None
    untraded_max_qty: int | None = None
    untraded_max_intra_ms: int | None = None
    untraded_peaks: tuple[AskPeakCandidateRow, ...] = ()
    untraded_max_peaks: tuple[AskPeakCandidateRow, ...] = ()


def query_bucketed_ratio(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_close_ms: int | None = None,
) -> list[QuoteRatioRow]:
    """Bucket snapshots and emit the depth totals of the LAST snapshot per bucket.

    For each bucket, ``ask_total`` / ``bid_total`` are the SUM across all 10
    ask_q / bid_q level columns of the bucket's representative snapshot.

    The representative is the last *continuous-trading* snapshot. The closing
    Auction Window (and intraday VI) collapses the book to 3 levels per side, so a
    snapshot is continuous-trading iff it shows depth beyond level 3
    (``_ASK_DEEP_SUM`` / ``_BID_DEEP_SUM`` > 0). ``last_continuous_ms`` = the last
    continuous snapshot at/before ``session_close_ms``; ``pre_auction_pred`` is true
    for rows at/before it, and ``ORDER BY (pred) DESC, ts_ms DESC`` puts those first
    so ``rn = 1`` picks the last pre-auction row — falling back to the last overall
    row when a bucket has none (fully inside the auction window, left for the display
    Auction Mask, ADR-0029). This structural boundary replaces the prior
    ``session_close - 10min`` clock, which mis-sliced the tail bucket when the real
    continuous→auction transition drifted off 15:20:00 (observed 15:20:01.xx). The
    ``<= session_close`` bound is load-bearing: every stock shows a post-cross book
    re-expansion (~15:30:14) that would otherwise pull the threshold past the
    auction. When ``session_close_ms`` is None (or no continuous snapshot exists)
    the predicate is the constant TRUE, so ``ORDER BY (TRUE) DESC, ts_ms DESC`` is
    exactly the legacy last-in-bucket behavior. See ADR-0062.

    Buckets on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding has
    gaps at minute / hour boundaries, so arithmetic bucketing of HHMMSSmmm
    produces invalid HHMMSSmmm values that decode to duplicate / out-of-order
    Unix-ms outputs — which lightweight-charts rejects with "asc ordered by
    time". Decoding to linear ms BEFORE bucketing yields strictly ascending,
    distinct buckets. See hhmmssms_to_intra_ms_sql.

    Returns rows in ascending ``bucket_intra_ms`` order. Empty parquet → [].
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    # Structural closing-auction boundary (ADR-0062). last_continuous_ms = the last
    # continuous-trading book (depth beyond level 3) at/before the session close;
    # everything after it is the auction. None (no session bound / no continuous
    # snapshot) -> TRUE predicate == legacy last-in-bucket.
    deep_book_sql = _DEEP_BOOK_SQL  # SSOT — same predicate as query_day_ask_peak & client isContinuousBook
    last_continuous_ms: int | None = None
    if session_close_ms is not None:
        close_intra_sql = hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))
        row = con.execute(
            f"SELECT max({intra_ms_expr}) FROM read_parquet(?) "
            f"WHERE {deep_book_sql} AND {intra_ms_expr} <= {close_intra_sql}",
            [str(path)],
        ).fetchone()
        if row is not None and row[0] is not None:
            last_continuous_ms = int(row[0])
    if last_continuous_ms is None:
        # No continuous-trading book at/before the session close (no session bound,
        # OR a degenerate dataset with no deep book). Either way fall back to the
        # legacy constant-TRUE last-in-bucket path: ORDER BY (TRUE) DESC, ts_ms DESC
        # == plain last-in-bucket (ADR-0062). Production continuous books always
        # carry deep levels (4..10 > 0), so last_continuous_ms is always set on real
        # data and this branch fires only on degenerate fixtures — restoring TRUE is
        # safe and matches the documented legacy fallback.
        pre_auction_pred = "TRUE"
    else:
        pre_auction_pred = f"({intra_ms_expr} <= {last_continuous_ms})"
    rows = con.execute(
        f"""
        WITH bucketed AS (
          SELECT ts_ms,
                 ({_ASK_Q_SUM}) AS ask_total,
                 ({_BID_Q_SUM}) AS bid_total,
                 ({pre_auction_pred}) AS is_pre,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY ({pre_auction_pred}) DESC, ts_ms DESC
                 ) AS rn,
                 -- Intra-Bar Max (ADR-0076): is_pre 게이트로 동시호가 스냅샷 배제.
                 MAX(CASE WHEN ({pre_auction_pred}) THEN ({_BID_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                 ) AS bid_max,
                 MAX(CASE WHEN ({pre_auction_pred}) THEN ({_ASK_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                 ) AS ask_max,
                 -- |imbalance| 최대 스냅샷의 (bid,ask) 쌍 — GREATEST/LEAST ratio는
                 -- |imbalance|+1 의 단조 대용. degenerate(한쪽 0)·동시호가는 0으로
                 -- 밀려 후순위. 동률은 가장 이른 ts_ms.
                 FIRST_VALUE(CASE WHEN ({pre_auction_pred}) THEN ({_BID_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY (CASE WHEN ({pre_auction_pred}) AND ({_BID_Q_SUM}) > 0 AND ({_ASK_Q_SUM}) > 0
                               THEN GREATEST(({_ASK_Q_SUM}), ({_BID_Q_SUM})) * 1.0
                                    / LEAST(({_ASK_Q_SUM}), ({_BID_Q_SUM}))
                               ELSE 0 END) DESC, ts_ms ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                 ) AS imb_max_bid,
                 FIRST_VALUE(CASE WHEN ({pre_auction_pred}) THEN ({_ASK_Q_SUM}) ELSE 0 END) OVER (
                   PARTITION BY ({intra_ms_expr} // {bucket_ms})
                   ORDER BY (CASE WHEN ({pre_auction_pred}) AND ({_BID_Q_SUM}) > 0 AND ({_ASK_Q_SUM}) > 0
                               THEN GREATEST(({_ASK_Q_SUM}), ({_BID_Q_SUM})) * 1.0
                                    / LEAST(({_ASK_Q_SUM}), ({_BID_Q_SUM}))
                               ELSE 0 END) DESC, ts_ms ASC
                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
                 ) AS imb_max_ask
          FROM read_parquet(?)
        )
        -- A fully-auction bucket (rn=1 row is NOT pre-auction = it had no
        -- continuous-trading book, e.g. the closing 15:21-15:30 buckets) emits 0
        -- instead of the auction fallback, so the closing-auction 3-level book
        -- never enters the 호가비·총잔량 calculation regardless of the display
        -- Auction Mask toggle (ADR-0062). Straddle buckets keep their last
        -- continuous representative; intraday VI sits before the threshold
        -- (is_pre TRUE) and is retained. Intra-Bar Max fields are likewise zeroed
        -- on a fully-auction bucket so bid_max >= bid_total holds at the (0,0) sentinel.
        SELECT bucket * {bucket_ms},
               CASE WHEN is_pre THEN bid_total ELSE 0 END,
               CASE WHEN is_pre THEN ask_total ELSE 0 END,
               CASE WHEN is_pre THEN bid_max ELSE 0 END,
               CASE WHEN is_pre THEN ask_max ELSE 0 END,
               CASE WHEN is_pre THEN imb_max_bid ELSE 0 END,
               CASE WHEN is_pre THEN imb_max_ask ELSE 0 END
        FROM bucketed WHERE rn = 1 ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    return [
        QuoteRatioRow(
            bucket_intra_ms=int(r[0]), bid_total=int(r[1]), ask_total=int(r[2]),
            bid_max=int(r[3]), ask_max=int(r[4]),
            imb_max_bid=int(r[5]), imb_max_ask=int(r[6]),
        )
        for r in rows
    ]


def query_bucket_representative(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    lo_native: int,
    hi_native: int,
    session_close_ms: int | None = None,
) -> ApiOrderbookSnapshot | None:
    """Return the structural bucket-representative snapshot for the native-time
    window ``[lo_native, hi_native]`` (HHMMSSmmm, inclusive).

    The representative is the last *continuous-trading* book (depth beyond level
    3) at/before the session close. Shallow pre-threshold books are not
    eligible continuous representatives, and buckets with no qualifying
    continuous row return ``None``. This keeps the sidebar 10호가 spot view on
    the same continuous-only contract as saved views.

    ``session_close_ms`` None disables only the time threshold; the continuous
    depth requirement still applies. Returns None when no qualifying continuous
    snapshot falls in the window.
    """
    del con  # retained for the public table-query signature used by callers.
    index = _load_query_index(path)
    last_continuous_ms = _last_continuous_intra_ms_from_index(
        index, session_close_ms=session_close_ms
    )
    pos = bisect_right(index.ts_values, hi_native) - 1
    best_row: tuple[Any, ...] | None = None
    best_key: tuple[int, int] | None = None
    while pos >= 0 and index.ts_values[pos] >= lo_native:
        if best_key is not None and index.ts_values[pos] < best_key[0]:
            break
        if _row_is_representative_candidate(
            index,
            pos,
            last_continuous_ms=last_continuous_ms,
        ):
            row = index.rows[pos]
            key = (int(row[0]), int(row[1]))
            if best_key is None or key > best_key:
                best_key = key
                best_row = row
        pos -= 1
    if best_row is None:
        return None
    return _row_to_api_snapshot(best_row)


def query_bucket_representatives(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    buckets: list[tuple[int, int]],
    session_close_ms: int | None = None,
) -> dict[int, ApiOrderbookSnapshot]:
    """Return bucket representatives keyed by ``lo_native``.

    Matches :func:`query_bucket_representative` bucket-by-bucket:
    when ``session_close_ms`` is set, keep only the last deep continuous
    snapshot inside the window and omit buckets with no qualifying continuous
    row. When ``session_close_ms`` is None, only the close-time threshold is
    disabled; shallow or auction rows still never qualify.
    """
    if not buckets:
        return {}
    last_continuous_ms = _last_continuous_intra_ms(
        con, path=path, session_close_ms=session_close_ms
    )
    bucket_los = [int(lo) for lo, _hi in buckets]
    bucket_his = [int(hi) for _lo, hi in buckets]
    min_lo = min(bucket_los)
    max_hi = max(bucket_his)
    continuous_pred = _continuous_representative_pred_sql(
        intra_ms_expr="intra_ms",
        last_continuous_ms=last_continuous_ms,
    )
    rows = con.execute(
        f"""
        WITH buckets AS (
          SELECT
            UNNEST(?::BIGINT[]) AS lo_native,
            UNNEST(?::BIGINT[]) AS hi_native
        ),
        candidates AS (
          SELECT
            b.lo_native,
            s.*,
            {hhmmssms_to_intra_ms_sql("s.ts_ms")} AS intra_ms
          FROM buckets b
          JOIN read_parquet(?) s
            ON s.ts_ms BETWEEN b.lo_native AND b.hi_native
          WHERE s.ts_ms BETWEEN ? AND ?
        ),
        eligible AS (
          SELECT *
          FROM candidates
          WHERE {continuous_pred}
        ),
        ranked AS (
          SELECT
            *,
            ROW_NUMBER() OVER (
              PARTITION BY lo_native
              ORDER BY ts_ms DESC, seq DESC
            ) AS rn
          FROM eligible
        )
        SELECT lo_native, {_SELECT}
        FROM ranked
        WHERE rn = 1
        ORDER BY lo_native
        """,
        [bucket_los, bucket_his, str(path), min_lo, max_hi],
    ).fetchall()
    out: dict[int, ApiOrderbookSnapshot] = {}
    for row in rows:
        lo_native = int(row[0])
        out[lo_native] = _row_to_api_snapshot(row[1:])
    return out


def query_day_ask_peak(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> AskPeakRow | None:
    """당일 단일 매도 호가단계 최대 qty와 그 가격 — **총잔량 지표와 동일한 표현 위에서** 집계.

    raw 틱이 아니라 ``bucket_ms`` 버킷 대표값에서 찾는다. 버킷 대표 = 그 버킷의 마지막
    연속거래 스냅샷(``query_bucketed_ratio``의 ``ORDER BY ts_ms DESC`` rn=1과 동일 선택,
    단 연속거래행만 사전 필터). 분봉 호가창에서 사용자가 실제로 보는 건 그 분의 마지막
    연속거래 스냅샷이므로, raw 틱 max(분 사이 순간값)는 표시 호가창에 안 나타날 수 있다 —
    버킷 대표 위에서 찾아야 "표시한 곳에 실제로 보이는" 벽이 된다.

    동시호가는 세 경로 모두 배제(총잔량 지표와 동치):
      * **개장 동시호가**(<09:00): 10레벨 누적 호가라 ``_DEEP_BOOK_SQL``을 통과한다 →
        ``session_open_ms`` 하한으로 배제(총잔량의 surgeStartHHMM 시각 게이트에 대응하나,
        여기선 표시 prefs가 아닌 구조적 세션 경계를 쓴다).
      * **마감 동시호가 / 장중 VI**(3-레벨 단일가 붕괴): ``_DEEP_BOOK_SQL``이 구조적 배제.
      * **마감 교차 후 호가창 재확장**(~15:30:14): ``_DEEP_BOOK_SQL``을 통과한다 →
        ``session_close_ms`` 상한으로 배제(``query_bucketed_ratio``의 ``<= session_close``
        경계와 동일 목적).

    동률이면 가장 이른 시각. 빈 parquet(또는 세션 내 연속거래행 없음) → None. 파일 부재
    가드는 호출자(bundle) 책임. ``bucket_ms``는 > 0 (호출자 validate_bucket_ms 책임)."""
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    bounds = [_DEEP_BOOK_SQL]
    if session_open_ms is not None:
        bounds.append(f"{intra} >= {hhmmssms_to_intra_ms_sql(str(int(session_open_ms)))}")
    if session_close_ms is not None:
        bounds.append(f"{intra} <= {hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))}")
    where = " AND ".join(bounds)
    # 버킷별 대표 = 마지막 연속거래 스냅샷(rn=1 by ts_ms DESC). 연속거래행으로 사전 필터한 뒤
    # 버킷팅하므로 완전-동시호가 버킷은 행이 없어 자연 탈락(총잔량의 (0,0) 센티넬 불필요).
    def level_union(src: str) -> str:
        return " UNION ALL ".join(
            f"SELECT ask_p{i} AS price, ask_q{i} AS qty, {intra} AS intra_ms "
            f"FROM {src} WHERE ask_q{i} > 0"
            for i in range(1, ORDERBOOK_LEVELS + 1)
        )

    row = con.execute(
        f"""
        WITH cont AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra} // {int(bucket_ms)})
                   ORDER BY ts_ms DESC
                 ) AS rn
          FROM read_parquet(?) WHERE {where}
        ),
        rep AS (SELECT * FROM cont WHERE rn = 1)
        SELECT price, qty, intra_ms FROM ({level_union("rep")})
        ORDER BY qty DESC, intra_ms ASC LIMIT 1
        """,
        [str(path)],
    ).fetchone()
    if row is None:
        return None
    max_row = con.execute(
        f"""
        WITH src AS (SELECT * FROM read_parquet(?) WHERE {where})
        SELECT price, qty, intra_ms FROM ({level_union("src")})
        ORDER BY qty DESC, intra_ms ASC LIMIT 1
        """,
        [str(path)],
    ).fetchone()
    return AskPeakRow(
        price=int(row[0]), qty=int(row[1]), intra_ms=int(row[2]),
        max_price=int(max_row[0]), max_qty=int(max_row[1]), max_intra_ms=int(max_row[2]),
    )


def query_day_ask_peak_dual(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> AskPeakDualRow | None:
    """Past-day ask peak split into post-touch and post-untouched variants."""
    ask_row, _bid_row = query_day_ask_bid_peak_dual(
        con,
        path=path,
        trades_path=trades_path,
        bucket_ms=bucket_ms,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
    )
    return ask_row


def query_day_bid_peak(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> BidPeakRow | None:
    """Past-day bid peak over continuous-trading representative snapshots."""
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    bounds = [_DEEP_BOOK_SQL]
    if session_open_ms is not None:
        bounds.append(f"{intra} >= {hhmmssms_to_intra_ms_sql(str(int(session_open_ms)))}")
    if session_close_ms is not None:
        bounds.append(f"{intra} <= {hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))}")
    where = " AND ".join(bounds)

    def level_union(src: str) -> str:
        return " UNION ALL ".join(
            f"SELECT bid_p{i} AS price, bid_q{i} AS qty, {intra} AS intra_ms "
            f"FROM {src} WHERE bid_q{i} > 0"
            for i in range(1, ORDERBOOK_LEVELS + 1)
        )

    row = con.execute(
        f"""
        WITH cont AS (
          SELECT *,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra} // {int(bucket_ms)})
                   ORDER BY ts_ms DESC
                 ) AS rn
          FROM read_parquet(?) WHERE {where}
        ),
        rep AS (SELECT * FROM cont WHERE rn = 1)
        SELECT price, qty, intra_ms FROM ({level_union("rep")})
        ORDER BY qty DESC, intra_ms ASC LIMIT 1
        """,
        [str(path)],
    ).fetchone()
    if row is None:
        return None
    max_row = con.execute(
        f"""
        WITH src AS (SELECT * FROM read_parquet(?) WHERE {where})
        SELECT price, qty, intra_ms FROM ({level_union("src")})
        ORDER BY qty DESC, intra_ms ASC LIMIT 1
        """,
        [str(path)],
    ).fetchone()
    return BidPeakRow(
        price=int(row[0]), qty=int(row[1]), intra_ms=int(row[2]),
        max_price=int(max_row[0]), max_qty=int(max_row[1]), max_intra_ms=int(max_row[2]),
    )


def query_day_bid_peak_dual(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> BidPeakDualRow | None:
    """Past-day bid peak split into post-touch and post-untouched variants."""
    _ask_row, bid_row = query_day_ask_bid_peak_dual(
        con,
        path=path,
        trades_path=trades_path,
        bucket_ms=bucket_ms,
        session_open_ms=session_open_ms,
        session_close_ms=session_close_ms,
    )
    return bid_row


def query_day_ask_bid_peak_dual(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> tuple[AskPeakDualRow | None, BidPeakDualRow | None]:
    """Return ask and bid peak rows for the same day using shared scans."""
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    trade_seq_expr = "COALESCE(seq, 0)" if _parquet_has_column(con, trades_path, "seq") else "0"
    bounds = [_DEEP_BOOK_SQL]
    if session_open_ms is not None:
        bounds.append(f"{intra} >= {hhmmssms_to_intra_ms_sql(str(int(session_open_ms)))}")
    if session_close_ms is not None:
        bounds.append(f"{intra} <= {hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))}")
    where = " AND ".join(bounds)

    def level_union(src: str, side: str) -> str:
        price_prefix = "ask_p" if side == "ask" else "bid_p"
        qty_prefix = "ask_q" if side == "ask" else "bid_q"
        return " UNION ALL ".join(
            f"SELECT ts_ms, seq, {price_prefix}{i} AS price, {qty_prefix}{i} AS qty, "
            f"{intra} AS intra_ms, bucket_id "
            f"FROM {src} WHERE {qty_prefix}{i} > 0"
            for i in range(1, ORDERBOOK_LEVELS + 1)
        )

    def classified_levels(side: str, src: str) -> str:
        comparator = ">=" if side == "ask" else "<="
        future_col = "future_max_price" if side == "ask" else "future_min_price"
        return f"""
        {side}_{src}_classified AS (
          SELECT ts_ms, seq, price, qty, intra_ms, bucket_id,
                 COALESCE({future_col} {comparator} price, FALSE) AS is_touched
          FROM (
            SELECT combined.*,
                   MAX(CASE WHEN is_touch THEN touch_price ELSE NULL END) OVER (
                     ORDER BY ts_ms DESC, seq DESC, is_touch DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS future_max_price,
                   MIN(CASE WHEN is_touch THEN touch_price ELSE NULL END) OVER (
                     ORDER BY ts_ms DESC, seq DESC, is_touch DESC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                   ) AS future_min_price
            FROM (
              SELECT ts_ms, seq, price, qty, intra_ms, bucket_id,
                     FALSE AS is_touch, NULL::INTEGER AS touch_price
              FROM {side}_{src}_levels
              UNION ALL
              SELECT ts_ms, seq, NULL::INTEGER AS price, NULL::INTEGER AS qty,
                     NULL::BIGINT AS intra_ms, NULL::BIGINT AS bucket_id,
                     TRUE AS is_touch, price AS touch_price
              FROM touch_ticks
            ) combined
          )
          WHERE NOT is_touch
        )
        """

    def lifecycle_levels(side: str, src: str) -> str:
        comparator = ">=" if side == "ask" else "<="
        return f"""
        {side}_{src}_lifecycle_prices AS (
          SELECT DISTINCT price
          FROM {side}_{src}_classified
        ),
        {side}_{src}_lifecycle_stream AS (
          SELECT ts_ms, seq, price, qty, intra_ms, bucket_id, is_touched,
                 FALSE AS is_touch, NULL::BIGINT AS touch_ord
          FROM {side}_{src}_classified
          UNION ALL
          SELECT t.ts_ms, t.seq, p.price, NULL::INTEGER AS qty,
                 NULL::BIGINT AS intra_ms, NULL::BIGINT AS bucket_id,
                 FALSE AS is_touched, TRUE AS is_touch, t.touch_ord
          FROM touch_ticks t
          JOIN {side}_{src}_lifecycle_prices p
            ON t.price {comparator} p.price
        ),
        {side}_{src}_lifecycle_events AS (
          SELECT ts_ms, seq, price, qty, intra_ms, bucket_id, is_touched, is_touch,
                 COALESCE(
                   MAX(CASE WHEN is_touch THEN touch_ord ELSE NULL END) OVER (
                     PARTITION BY price
                     ORDER BY ts_ms ASC, seq ASC, is_touch ASC
                     ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
                   ),
                   0
                 ) AS lifecycle_id
          FROM {side}_{src}_lifecycle_stream
        ),
        {side}_{src}_lifecycle_wall_events AS (
          SELECT ts_ms, seq, price, qty, intra_ms, bucket_id, is_touched, lifecycle_id
          FROM {side}_{src}_lifecycle_events
          WHERE NOT is_touch
        ),
        {side}_{src}_lifecycle_ranked AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched, lifecycle_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, lifecycle_id
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS lifecycle_rn
          FROM {side}_{src}_lifecycle_wall_events
        ),
        {side}_{src}_lifecycle AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched
          FROM {side}_{src}_lifecycle_ranked
          WHERE lifecycle_rn = 1
        ),
        {side}_{src}_lifecycle_distinct_ranked AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, is_touched
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS price_status_rn
          FROM {side}_{src}_lifecycle
        ),
        {side}_{src}_lifecycle_distinct AS (
          SELECT price, qty, intra_ms, seq, bucket_id, is_touched
          FROM {side}_{src}_lifecycle_distinct_ranked
          WHERE price_status_rn = 1
        )
        """

    def scalar_and_array_ctes(side: str) -> str:
        return f"""
        {side}_all_close AS (
          SELECT '{side}_all_close' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_rep_classified
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_all_max AS (
          SELECT '{side}_all_max' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_cont_classified
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_traded_close AS (
          SELECT '{side}_traded_close' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_rep_lifecycle_distinct
          WHERE is_touched
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_traded_max AS (
          SELECT '{side}_traded_max' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_cont_lifecycle_distinct
          WHERE is_touched
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_untraded_close AS (
          SELECT '{side}_untraded_close' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_rep_lifecycle_distinct
          WHERE NOT is_touched
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_untraded_max AS (
          SELECT '{side}_untraded_max' AS kind, price, qty, intra_ms, 0 AS ord
          FROM {side}_cont_lifecycle_distinct
          WHERE NOT is_touched
          ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
          LIMIT 1
        ),
        {side}_traded_peaks AS (
          SELECT '{side}_traded_peak' AS kind, price, qty, intra_ms, ord
          FROM (
            SELECT price, qty, intra_ms,
                   ROW_NUMBER() OVER (
                     ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                   ) AS ord
            FROM {side}_rep_lifecycle_distinct
            WHERE is_touched
          )
          WHERE ord <= 3
        ),
        {side}_traded_max_peaks AS (
          SELECT '{side}_traded_max_peak' AS kind, price, qty, intra_ms, ord
          FROM (
            SELECT price, qty, intra_ms,
                   ROW_NUMBER() OVER (
                     ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                   ) AS ord
            FROM {side}_cont_lifecycle_distinct
            WHERE is_touched
          )
          WHERE ord <= 3
        ),
        {side}_untraded_peaks AS (
          SELECT '{side}_untraded_peak' AS kind, price, qty, intra_ms, ord
          FROM (
            SELECT price, qty, intra_ms,
                   ROW_NUMBER() OVER (
                     ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                   ) AS ord
            FROM {side}_rep_lifecycle_distinct
            WHERE NOT is_touched
          )
          WHERE ord <= 3
        ),
        {side}_untraded_max_peaks AS (
          SELECT '{side}_untraded_max_peak' AS kind, price, qty, intra_ms, ord
          FROM (
            SELECT price, qty, intra_ms,
                   ROW_NUMBER() OVER (
                     ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                   ) AS ord
            FROM {side}_cont_lifecycle_distinct
            WHERE NOT is_touched
          )
          WHERE ord <= 3
        ),
        {side}_all_peak_candidates AS (
          SELECT price, qty, intra_ms, seq, bucket_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, bucket_id
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS price_rn
          FROM {side}_rep_classified
        ),
        {side}_all_peaks AS (
          SELECT '{side}_all_peak' AS kind, price, qty, intra_ms,
                 ROW_NUMBER() OVER (
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS ord
          FROM {side}_all_peak_candidates
          WHERE price_rn = 1
        ),
        {side}_all_max_peak_candidates AS (
          SELECT price, qty, intra_ms, seq, bucket_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY price, bucket_id
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS price_rn
          FROM {side}_cont_classified
        ),
        {side}_all_max_peaks AS (
          SELECT '{side}_all_max_peak' AS kind, price, qty, intra_ms,
                 ROW_NUMBER() OVER (
                   ORDER BY qty DESC, intra_ms ASC, seq ASC, price ASC
                 ) AS ord
          FROM {side}_all_max_peak_candidates
          WHERE price_rn = 1
        )
        """

    rows = con.execute(
        f"""
        WITH cont AS (
          SELECT *,
                 ({intra} // {int(bucket_ms)}) AS bucket_id,
                 ROW_NUMBER() OVER (
                   PARTITION BY ({intra} // {int(bucket_ms)})
                   ORDER BY ts_ms DESC, seq DESC
                 ) AS rn
          FROM read_parquet(?) WHERE {where}
        ),
        rep AS (SELECT * FROM cont WHERE rn = 1),
        touch_ticks AS (
          SELECT ts_ms, seq, price,
                 ROW_NUMBER() OVER (ORDER BY ts_ms ASC, seq ASC, price ASC) AS touch_ord
          FROM (
            SELECT ts_ms, {trade_seq_expr} AS seq, price
            FROM read_parquet(?)
            WHERE side IN (1, -1) AND price > 0
          )
        ),
        ask_rep_levels AS ({level_union("rep", "ask")}),
        ask_cont_levels AS ({level_union("cont", "ask")}),
        bid_rep_levels AS ({level_union("rep", "bid")}),
        bid_cont_levels AS ({level_union("cont", "bid")}),
        {classified_levels("ask", "rep")},
        {classified_levels("ask", "cont")},
        {classified_levels("bid", "rep")},
        {classified_levels("bid", "cont")},
        {lifecycle_levels("ask", "rep")},
        {lifecycle_levels("ask", "cont")},
        {lifecycle_levels("bid", "rep")},
        {lifecycle_levels("bid", "cont")},
        {scalar_and_array_ctes("ask")},
        {scalar_and_array_ctes("bid")}
        SELECT * FROM ask_all_close
        UNION ALL SELECT * FROM ask_all_max
        UNION ALL SELECT * FROM ask_traded_close
        UNION ALL SELECT * FROM ask_traded_max
        UNION ALL SELECT * FROM ask_untraded_close
        UNION ALL SELECT * FROM ask_untraded_max
        UNION ALL SELECT * FROM ask_traded_peaks
        UNION ALL SELECT * FROM ask_traded_max_peaks
        UNION ALL SELECT * FROM ask_untraded_peaks
        UNION ALL SELECT * FROM ask_untraded_max_peaks
        UNION ALL SELECT * FROM ask_all_peaks
        UNION ALL SELECT * FROM ask_all_max_peaks
        UNION ALL SELECT * FROM bid_all_close
        UNION ALL SELECT * FROM bid_all_max
        UNION ALL SELECT * FROM bid_traded_close
        UNION ALL SELECT * FROM bid_traded_max
        UNION ALL SELECT * FROM bid_traded_peaks
        UNION ALL SELECT * FROM bid_traded_max_peaks
        UNION ALL SELECT * FROM bid_untraded_peaks
        UNION ALL SELECT * FROM bid_untraded_max_peaks
        UNION ALL SELECT * FROM bid_all_peaks
        UNION ALL SELECT * FROM bid_all_max_peaks
        UNION ALL SELECT * FROM bid_untraded_close
        UNION ALL SELECT * FROM bid_untraded_max
        """,
        [str(path), str(trades_path)],
    ).fetchall()

    single: dict[str, tuple[int, int, int]] = {}
    many: dict[str, list[AskPeakCandidateRow]] = {
        "ask_traded_peak": [],
        "ask_traded_max_peak": [],
        "ask_untraded_peak": [],
        "ask_untraded_max_peak": [],
        "ask_all_peak": [],
        "ask_all_max_peak": [],
        "bid_traded_peak": [],
        "bid_traded_max_peak": [],
        "bid_untraded_peak": [],
        "bid_untraded_max_peak": [],
        "bid_all_peak": [],
        "bid_all_max_peak": [],
    }
    for kind, price, qty, intra_ms, _ord in rows:
        item = (int(price), int(qty), int(intra_ms))
        if kind in many:
            many[kind].append(AskPeakCandidateRow(price=item[0], qty=item[1], intra_ms=item[2]))
        else:
            single[str(kind)] = item

    ask_all_close = single.get("ask_all_close")
    ask_all_max = single.get("ask_all_max")
    ask_row: AskPeakDualRow | None = None
    if ask_all_close is not None and ask_all_max is not None:
        ask_traded_close = single.get("ask_traded_close")
        ask_traded_max = single.get("ask_traded_max")
        traded_peaks = tuple(many["ask_traded_peak"])
        traded_max_peaks = tuple(many["ask_traded_max_peak"])
        untraded_peaks = tuple(many["ask_untraded_peak"])
        untraded_max_peaks = tuple(many["ask_untraded_max_peak"])
        all_peaks = tuple(many["ask_all_peak"])
        all_max_peaks = tuple(many["ask_all_max_peak"])
        ask_untraded_close = single.get("ask_untraded_close")
        ask_untraded_max = single.get("ask_untraded_max")
        ask_row = AskPeakDualRow(
            price=ask_traded_close[0] if ask_traded_close is not None else None,
            qty=ask_traded_close[1] if ask_traded_close is not None else None,
            intra_ms=ask_traded_close[2] if ask_traded_close is not None else None,
            max_price=ask_traded_max[0] if ask_traded_max is not None else None,
            max_qty=ask_traded_max[1] if ask_traded_max is not None else None,
            max_intra_ms=ask_traded_max[2] if ask_traded_max is not None else None,
            traded_peaks=traded_peaks,
            traded_max_peaks=traded_max_peaks,
            all_price=ask_all_close[0], all_qty=ask_all_close[1], all_intra_ms=ask_all_close[2],
            all_max_price=ask_all_max[0], all_max_qty=ask_all_max[1], all_max_intra_ms=ask_all_max[2],
            all_peaks=all_peaks,
            all_max_peaks=all_max_peaks,
            untraded_price=ask_untraded_close[0] if ask_untraded_close is not None else None,
            untraded_qty=ask_untraded_close[1] if ask_untraded_close is not None else None,
            untraded_intra_ms=ask_untraded_close[2] if ask_untraded_close is not None else None,
            untraded_max_price=ask_untraded_max[0] if ask_untraded_max is not None else None,
            untraded_max_qty=ask_untraded_max[1] if ask_untraded_max is not None else None,
            untraded_max_intra_ms=ask_untraded_max[2] if ask_untraded_max is not None else None,
            untraded_peaks=untraded_peaks,
            untraded_max_peaks=untraded_max_peaks,
        )

    bid_all_close = single.get("bid_all_close")
    bid_all_max = single.get("bid_all_max")
    bid_row: BidPeakDualRow | None = None
    if bid_all_close is not None and bid_all_max is not None:
        bid_traded_close = single.get("bid_traded_close")
        bid_traded_max = single.get("bid_traded_max")
        bid_traded_peaks = tuple(many["bid_traded_peak"])
        bid_traded_max_peaks = tuple(many["bid_traded_max_peak"])
        bid_untraded_peaks = tuple(many["bid_untraded_peak"])
        bid_untraded_max_peaks = tuple(many["bid_untraded_max_peak"])
        bid_all_peaks = tuple(many["bid_all_peak"])
        bid_all_max_peaks = tuple(many["bid_all_max_peak"])
        bid_untraded_close = single.get("bid_untraded_close")
        bid_untraded_max = single.get("bid_untraded_max")
        bid_row = BidPeakDualRow(
            price=bid_traded_close[0] if bid_traded_close is not None else None,
            qty=bid_traded_close[1] if bid_traded_close is not None else None,
            intra_ms=bid_traded_close[2] if bid_traded_close is not None else None,
            max_price=bid_traded_max[0] if bid_traded_max is not None else None,
            max_qty=bid_traded_max[1] if bid_traded_max is not None else None,
            max_intra_ms=bid_traded_max[2] if bid_traded_max is not None else None,
            traded_peaks=bid_traded_peaks,
            traded_max_peaks=bid_traded_max_peaks,
            all_price=bid_all_close[0], all_qty=bid_all_close[1], all_intra_ms=bid_all_close[2],
            all_max_price=bid_all_max[0], all_max_qty=bid_all_max[1], all_max_intra_ms=bid_all_max[2],
            all_peaks=bid_all_peaks,
            all_max_peaks=bid_all_max_peaks,
            untraded_price=bid_untraded_close[0] if bid_untraded_close is not None else None,
            untraded_qty=bid_untraded_close[1] if bid_untraded_close is not None else None,
            untraded_intra_ms=bid_untraded_close[2] if bid_untraded_close is not None else None,
            untraded_max_price=bid_untraded_max[0] if bid_untraded_max is not None else None,
            untraded_max_qty=bid_untraded_max[1] if bid_untraded_max is not None else None,
            untraded_max_intra_ms=bid_untraded_max[2] if bid_untraded_max is not None else None,
            untraded_peaks=bid_untraded_peaks,
            untraded_max_peaks=bid_untraded_max_peaks,
        )
    return ask_row, bid_row
