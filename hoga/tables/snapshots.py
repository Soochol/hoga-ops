"""Snapshots table — 10-level orderbook state.

Each event type 2 row is a full state snapshot. In-memory the entity uses
10-tuples for price/qty/delta arrays; on disk those are flattened into
``ask_p1..ask_p10``, ``ask_q1..ask_q10``, ``ask_d1..ask_d10`` etc. columns.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any

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


# Each ask_qN/bid_qN column is INT32 (see PARQUET_SCHEMA). On an extreme order
# book (e.g. a limit-up small-cap with hundreds of millions of shares per
# level) the plain INT32 SUM overflows DuckDB's INT32 accumulator and raises
# OutOfRangeException, surfacing as an HTTP 500 from the 호가비/총잔량 API. The
# ``::BIGINT`` cast on each term widens the accumulator to 64-bit; it is a
# type widening only, so all in-range (non-overflow) results are byte-identical.
_ASK_Q_SUM: str = " + ".join(f"ask_q{i}::BIGINT" for i in range(1, ORDERBOOK_LEVELS + 1))
_BID_Q_SUM: str = " + ".join(f"bid_q{i}::BIGINT" for i in range(1, ORDERBOOK_LEVELS + 1))

# Single-price auction is detected by orderbook STRUCTURE, not a 15:20 clock
# (ADR-0062). KRX single-price phases (closing auction, intraday VI) expose exactly
# the top 3 levels per side; a continuous-trading book still has depth beyond level
# 3 on both sides. _ASK_DEEP_SUM / _BID_DEEP_SUM sum the deep (level 4..10) columns so
# query_bucketed_ratio can test "is this a continuous-trading book?". Cast to
# BIGINT for the same INT32-overflow reason as _ASK_Q_SUM / _BID_Q_SUM above.
_AUCTION_BOOK_DEPTH: int = 3
_ASK_DEEP_SUM: str = " + ".join(
    f"ask_q{i}::BIGINT" for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
)
_BID_DEEP_SUM: str = " + ".join(
    f"bid_q{i}::BIGINT" for i in range(_AUCTION_BOOK_DEPTH + 1, ORDERBOOK_LEVELS + 1)
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

# query_bucketed_depth_heatmap 의 struct 언팩 키 — 버킷마다 f-string 을 재생성하지
# 않도록 모듈 로드 시 1회 만든다(수백 버킷 × 40컬럼 재포맷 제거).
_DEPTH_ASK_P_KEYS: tuple[str, ...] = tuple(f"ask_p{i}" for i in range(1, ORDERBOOK_LEVELS + 1))
_DEPTH_ASK_Q_KEYS: tuple[str, ...] = tuple(f"ask_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1))
_DEPTH_BID_P_KEYS: tuple[str, ...] = tuple(f"bid_p{i}" for i in range(1, ORDERBOOK_LEVELS + 1))
_DEPTH_BID_Q_KEYS: tuple[str, ...] = tuple(f"bid_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1))


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


# ── Peak-wall linear sweep classifier (replaces the O(N·M) non-equi-join SQL) ──
#
# The former single-SQL classifier (ADR-0084) materialised a non-equi join
# ``touch × lifecycle_prices ON t.price {>=|<=} p.price`` plus an UNBOUNDED
# window over every ask/bid × rep/cont set — 17GB RSS / 155s on the worst day
# (20260623/000660). This sweep computes the identical semantics in
# O((N+M) log M): one reverse pass for ``is_touched`` and one forward pass with
# a prefix-max Fenwick tree for lifecycle segment ids. See ADR-0085.


@dataclass(frozen=True, slots=True)
class _WallEvent:
    ts_ms: int
    seq: int
    price: int
    qty: int
    intra_ms: int
    bucket_id: int


@dataclass(frozen=True, slots=True)
class _Touch:
    ts_ms: int
    seq: int
    price: int


def _event_rank_key(e: _WallEvent) -> tuple[int, int, int, int]:
    # SQL 공통 랭킹: qty DESC, intra_ms ASC, seq ASC, price ASC.
    return (-e.qty, e.intra_ms, e.seq, e.price)


class _MaxFenwick:
    """1-based prefix-max Fenwick (Binary Indexed) tree over positive ordinals."""

    def __init__(self, size: int) -> None:
        self._size = size
        self._tree = [0] * (size + 1)

    def update(self, i: int, value: int) -> None:
        tree = self._tree
        while i <= self._size:
            if tree[i] < value:
                tree[i] = value
            i += i & (-i)

    def prefix_max(self, i: int) -> int:
        best = 0
        tree = self._tree
        while i > 0:
            if tree[i] > best:
                best = tree[i]
            i -= i & (-i)
        return best


def _classify_wall_stream(
    events: list[_WallEvent],
    touches: list[_Touch],
    *,
    side: str,
) -> tuple[list[tuple[_WallEvent, bool]], dict[tuple[int, bool], _WallEvent]]:
    """Linear-sweep replacement for the quadratic lifecycle SQL (ADR-0085).

    Returns ``(classified, distinct_best)``:
      classified    — ``(event, is_touched)`` in (ts_ms, seq) ascending order,
                      mirroring ``{side}_{src}_classified``.
      distinct_best — best event per ``(price, is_touched)`` after per-``(price,
                      lifecycle_id)`` dedup; mirrors ``{side}_{src}_lifecycle_distinct``.

    Semantics contract (must match the former SQL exactly):
      is_touched — a level event ``e`` is touched iff some touch with
                   ``(ts, seq) >= e``'s dominates it price-wise
                   (ask: ``touch.price >= e.price``; bid: ``<=``).
                   Same-``(ts, seq)`` touches ARE included (``is_touch DESC``).
      lifecycle  — segmented by STRICTLY-earlier dominating touches
                   (``(ts, seq) < e``, so same-``(ts, seq)`` touches are excluded,
                   ``is_touch ASC``); ``lifecycle_id`` = the max touch ordinal of
                   those, else 0. Touch ordinal = rank in (ts, seq, price) order.
    """
    is_ask = side == "ask"
    events_sorted = sorted(events, key=lambda e: (e.ts_ms, e.seq))
    # touches_sorted key (ts, seq, price) == SQL touch_ord ROW_NUMBER order,
    # so a touch's 1-based list position IS its touch_ord.
    touches_sorted = sorted(touches, key=lambda t: (t.ts_ms, t.seq, t.price))

    # ── pass 1 (reverse): is_touched via a running future extreme ────────────
    classified: list[tuple[_WallEvent, bool]] = [None] * len(events_sorted)  # type: ignore[list-item]
    ti = len(touches_sorted) - 1
    future_extreme: int | None = None
    for ei in range(len(events_sorted) - 1, -1, -1):
        e = events_sorted[ei]
        while ti >= 0 and (touches_sorted[ti].ts_ms, touches_sorted[ti].seq) >= (e.ts_ms, e.seq):
            tp = touches_sorted[ti].price
            if future_extreme is None or (tp > future_extreme if is_ask else tp < future_extreme):
                future_extreme = tp
            ti -= 1
        touched = future_extreme is not None and (
            future_extreme >= e.price if is_ask else future_extreme <= e.price
        )
        classified[ei] = (e, touched)

    # ── pass 2 (forward): lifecycle ids via Fenwick prefix-max over touch prices ──
    uniq = sorted({t.price for t in touches_sorted})
    fen = _MaxFenwick(len(uniq))
    if is_ask:
        # rank prices from the TOP so prefix_max(idx) covers touches with price >= q.
        def _touch_idx(price: int) -> int:
            return len(uniq) - bisect_left(uniq, price)

        _query_idx = _touch_idx
    else:
        # rank from the BOTTOM so prefix_max(idx) covers touches with price <= q.
        def _touch_idx(price: int) -> int:
            return bisect_left(uniq, price) + 1

        def _query_idx(price: int) -> int:
            return bisect_right(uniq, price)

    lifecycle_best: dict[tuple[int, int], tuple[_WallEvent, bool]] = {}
    ti = 0
    n_touch = len(touches_sorted)
    for e, touched in classified:
        while ti < n_touch and (
            (touches_sorted[ti].ts_ms, touches_sorted[ti].seq) < (e.ts_ms, e.seq)
        ):
            fen.update(_touch_idx(touches_sorted[ti].price), ti + 1)
            ti += 1
        lifecycle_id = fen.prefix_max(_query_idx(e.price))
        key = (e.price, lifecycle_id)
        cur = lifecycle_best.get(key)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur[0]):
            lifecycle_best[key] = (e, touched)

    distinct_best: dict[tuple[int, bool], _WallEvent] = {}
    for (price, _lid), (e, touched) in lifecycle_best.items():
        key2 = (price, touched)
        cur2 = distinct_best.get(key2)
        if cur2 is None or _event_rank_key(e) < _event_rank_key(cur2):
            distinct_best[key2] = e

    return classified, distinct_best


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
    """Bucket snapshots and emit the depth totals of the representative snapshot per bucket.

    For each bucket, ``ask_total`` / ``bid_total`` are the SUM across all 10
    ask_q / bid_q level columns of the bucket's representative snapshot.

    The representative is the last *continuous-trading* snapshot. The closing
    Auction Window (and intraday VI) collapses the book to 3 levels per side, so a
    snapshot is continuous-trading iff it shows depth beyond level 3
    (``_ASK_DEEP_SUM`` / ``_BID_DEEP_SUM`` > 0). ``last_continuous_ms`` = the last
    continuous snapshot at/before ``session_close_ms``; ``pre_auction_pred``
    (``is_pre``) is true for rows at/before it. Within a bucket, is_pre rows
    outrank non-is_pre rows for the representative pick, falling back to the
    last overall row when a bucket has none (fully inside the auction window,
    left for the display Auction Mask, ADR-0029). This structural boundary
    replaces the prior ``session_close - 10min`` clock, which mis-sliced the
    tail bucket when the real continuous→auction transition drifted off
    15:20:00 (observed 15:20:01.xx). The ``<= session_close`` bound is
    load-bearing: every stock shows a post-cross book re-expansion (~15:30:14)
    that would otherwise pull the threshold past the auction. When
    ``session_close_ms`` is None (or no continuous snapshot exists) the
    predicate is the constant TRUE, i.e. plain last-in-bucket. See ADR-0062.

    Buckets on LINEAR ms-from-midnight, not raw HHMMSSmmm. The raw encoding has
    gaps at minute / hour boundaries, so arithmetic bucketing of HHMMSSmmm
    produces invalid HHMMSSmmm values that decode to duplicate / out-of-order
    Unix-ms outputs — which lightweight-charts rejects with "asc ordered by
    time". Decoding to linear ms BEFORE bucketing yields strictly ascending,
    distinct buckets. See hhmmssms_to_intra_ms_sql.

    A fully-auction bucket (its representative row is NOT pre-auction = it had
    no continuous-trading book, e.g. the closing 15:21-15:30 buckets) emits 0
    instead of the auction fallback, so the closing-auction 3-level book never
    enters the 호가비·총잔량 calculation regardless of the display Auction
    Mask toggle (ADR-0062). Straddle buckets keep their last continuous
    representative; intraday VI sits before the threshold (is_pre TRUE) and is
    retained.

    Intra-Bar Max fields (ADR-0076): ``bid_max`` / ``ask_max`` are the
    bucket's independent max of bid_total / ask_total across its is_pre rows;
    ``imb_max_bid`` / ``imb_max_ask`` are the (bid_total, ask_total) pair of
    the is_pre row with the largest |imbalance| (GREATEST/LEAST ratio, a
    monotonic stand-in), tiebroken by the EARLIEST ts_ms. All four fields are
    zeroed on a fully-auction bucket, matching the (0, 0) sentinel above.

    Implementation: a single GROUP BY using arg_max/arg_min/MAX aggregates
    (no windowed materialization). Every per-row input (``gb``/``ga``/
    ``imb_key``) is gated by ``is_pre`` BEFORE aggregation, so a
    fully-auction bucket (no pre row) has every gated input = 0 for every
    row and all aggregates naturally emit 0/(0,0) for it — no outer
    ``CASE WHEN is_pre`` needed on the final SELECT. The representative row
    (bid_total/ask_total) is selected by ONE
    ``arg_max(struct_pack(b, a), rep_key)`` so both totals always come from
    the same physical row. ``rep_key = is_pre_int * 100_000_000 + intra_ms``
    reproduces "is_pre DESC, ts_ms DESC" ranking: pre rows outrank non-pre
    rows (the *1e8 digit dominates), and within the same is_pre tier, larger
    intra_ms (== larger ts_ms, monotonic within a bucket) wins — arg_max
    picks the row with the maximum key, i.e. the LAST such row. The
    imbalance-extreme pair (imb_max_bid/imb_max_ask) is selected by ONE
    ``arg_min(struct_pack(b, a), struct_pack(neg_imb, ts))`` so both values
    always come from the same row. Negating imb_key turns "want max
    imb_key" into "want min neg_imb", and the secondary ``ts_ms``
    (ascending) key reproduces the ``ts_ms ASC`` tiebreak for equal
    imb_key.

    This rewrite replaced an earlier 5-window-function implementation
    (1 ROW_NUMBER + 2 MAX OVER + 2 FIRST_VALUE with UNBOUNDED frames);
    a real-data differential over 11,398 capture files (production
    session_close_ms values) confirmed row-identical output — 0 mismatches,
    0 regressions (14 files showed pre-existing same-ts_ms
    representative-row nondeterminism unrelated to the rewrite). See
    ``tests/test_tables_snapshots.py`` golden-value tests.

    Returns rows in ascending ``bucket_intra_ms`` order. Empty parquet → [].
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
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
        # 세션 바운드 없음 OR deep book 부재(퇴화 fixture) — last-in-bucket 폴백 유지
        # (ADR-0062). 실데이터는 항상 세션 바운드 + deep book이라 이 분기는 집계 단위
        # 테스트/퇴화 데이터에서만 발화한다.
        pre_auction_pred = "TRUE"
    else:
        # ADR-0062 v2 (VI 통일): `_DEEP_BOOK_SQL`(4호가 이상 잔량)을 AND해 마감 동시호가
        # 뿐 아니라 **장중 VI 단일가 붕괴책도** 대표선정에서 구조적으로 배제한다
        # (query_bucket_representatives·피크와 동일 SSOT 술어). 시간 경계는 마감 후
        # 호가창 재확장(~15:30:14) 유입을 계속 막는다.
        pre_auction_pred = f"({deep_book_sql} AND {intra_ms_expr} <= {last_continuous_ms})"
    rows = con.execute(
        f"""
        WITH keyed AS (
          SELECT ts_ms,
                 ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 (CASE WHEN ({pre_auction_pred}) THEN ({_BID_Q_SUM}) ELSE 0 END) AS gb,
                 (CASE WHEN ({pre_auction_pred}) THEN ({_ASK_Q_SUM}) ELSE 0 END) AS ga,
                 (CASE WHEN ({pre_auction_pred}) AND ({_BID_Q_SUM}) > 0 AND ({_ASK_Q_SUM}) > 0
                     THEN GREATEST(({_ASK_Q_SUM}), ({_BID_Q_SUM})) * 1.0
                          / LEAST(({_ASK_Q_SUM}), ({_BID_Q_SUM}))
                     ELSE 0 END) AS imb_key,
                 ((CASE WHEN ({pre_auction_pred}) THEN 1 ELSE 0 END) * 100000000
                   + ({intra_ms_expr})) AS rep_key
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms},
               arg_max(struct_pack(b := gb, a := ga), rep_key) AS rep,
               max(gb) AS bid_max,
               max(ga) AS ask_max,
               arg_min(struct_pack(b := gb, a := ga), struct_pack(neg_imb := -imb_key, ts := ts_ms)) AS imb
        FROM keyed
        GROUP BY bucket
        ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    return [
        QuoteRatioRow(
            bucket_intra_ms=int(r[0]),
            bid_total=int(r[1]["b"]), ask_total=int(r[1]["a"]),
            bid_max=int(r[2]), ask_max=int(r[3]),
            imb_max_bid=int(r[4]["b"]), imb_max_ask=int(r[4]["a"]),
        )
        for r in rows
    ]


@dataclass(frozen=True)
class DepthHeatmapRow:
    """버킷 대표(마지막 연속거래) 스냅샷의 10단계 매도/매수 가격·잔량.

    ``bucket_intra_ms``는 LINEAR ms-from-midnight (NOT raw HHMMSSmmm, NOT unix
    ms) — 호출자가 ``ms_from_midnight_to_unix_ms(date, bucket_intra_ms)``로 unix
    변환. QuoteRatioRow.bucket_intra_ms와 동일 규약. 대표 선택 규칙도
    query_bucketed_ratio와 동일(is_pre DESC, ts_ms DESC).

    ``ask_prices``/``ask_qtys``는 index 0 = 최우선(best) 호가. 완전-auction
    버킷은 대표가 없어도 last-in-bucket으로 폴백(정규화는 프론트가 담당하므로
    표시상 문제 없음 — 총잔량 지표처럼 0으로 지울 필요 없다).

    ``*_max`` 필드(분봉 내 최댓값): 버킷 내 총잔량(bid+ask 10레벨 합)이 최대였던
    스냅샷의 40컬럼(캔들 고가처럼 "분봉 내 최댓값 기준" 토글용). 대표(종가)와 독립.
    """

    bucket_intra_ms: int
    ask_prices: tuple[int, ...]
    ask_qtys: tuple[int, ...]
    bid_prices: tuple[int, ...]
    bid_qtys: tuple[int, ...]
    ask_prices_max: tuple[int, ...]
    ask_qtys_max: tuple[int, ...]
    bid_prices_max: tuple[int, ...]
    bid_qtys_max: tuple[int, ...]


def query_bucketed_depth_heatmap(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_close_ms: int | None = None,
) -> list[DepthHeatmapRow]:
    """버킷별 대표 스냅샷의 10단계 가격·잔량을 방출한다.

    대표 = 마지막 연속거래 스냅샷(query_bucketed_ratio와 동일 정의). 40개 레벨
    컬럼을 하나의 struct_pack으로 묶어 arg_max(rep_key)로 한 물리 행에서 함께
    가져온다 — 총잔량 대신 개별 레벨을 보존하는 것만 다르다. Empty parquet → [].

    ``*_max`` 필드는 버킷 내 총잔량(bid+ask 10레벨 합)이 최대였던 스냅샷의 40컬럼
    (캔들 고가처럼 "분봉 내 최댓값 기준"). 정렬 키는 산술 ``is_pre*1e8 + total``이
    아니라 COMPOSITE struct ``struct_pack(is_pre, total)``을 쓴다 — 총잔량이 1억주를
    넘을 수 있어(상한가 소형주) 1e8 구간을 넘쳐 순위를 오염시키기 때문. struct는
    필드 순서대로 사전식 비교되므로 is_pre 우선(연속거래 > 동시호가), 그 안에서 total
    최대가 뽑힌다 — query_bucketed_ratio의 imb_max struct 키와 동일한 기법.
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    last_continuous_ms: int | None = None
    if session_close_ms is not None:
        last_continuous_ms = _last_continuous_intra_ms(
            con, path=path, session_close_ms=session_close_ms
        )
    if last_continuous_ms is None:
        pre_auction_pred = "TRUE"   # 세션 바운드 없음/퇴화 — last-in-bucket 폴백(호가비와 동일)
    else:
        # ADR-0062 v2 (VI 통일): `_DEEP_BOOK_SQL`을 AND해 장중 VI 붕괴책을 대표선정에서
        # 배제(마감 동시호가는 시간 경계가 그대로 처리). 호가비와 동일 규칙.
        pre_auction_pred = f"({_DEEP_BOOK_SQL} AND {intra_ms_expr} <= {last_continuous_ms})"

    level_cols = []
    for i in range(1, ORDERBOOK_LEVELS + 1):
        level_cols.append(f"ask_p{i} := ask_p{i}")
        level_cols.append(f"ask_q{i} := ask_q{i}")
        level_cols.append(f"bid_p{i} := bid_p{i}")
        level_cols.append(f"bid_q{i} := bid_q{i}")
    struct_body = ", ".join(level_cols)
    passthrough_cols = ", ".join(
        f"ask_p{i}, ask_q{i}, bid_p{i}, bid_q{i}"
        for i in range(1, ORDERBOOK_LEVELS + 1)
    )

    rows = con.execute(
        f"""
        WITH keyed AS (
          SELECT ({intra_ms_expr} // {bucket_ms}) AS bucket,
                 ((CASE WHEN ({pre_auction_pred}) THEN 1 ELSE 0 END) * 100000000
                   + ({intra_ms_expr})) AS rep_key,
                 (CASE WHEN ({pre_auction_pred}) THEN 1 ELSE 0 END) AS is_pre,
                 (({_BID_Q_SUM}) + ({_ASK_Q_SUM})) AS total,
                 {passthrough_cols}
          FROM read_parquet(?)
        )
        SELECT bucket * {bucket_ms} AS bucket_intra_ms,
               arg_max(struct_pack({struct_body}), rep_key) AS rep,
               arg_max(struct_pack({struct_body}),
                       struct_pack(is_pre := is_pre, total := total)) AS rep_max
        FROM keyed
        GROUP BY bucket
        ORDER BY bucket
        """,
        [str(path)],
    ).fetchall()
    out: list[DepthHeatmapRow] = []
    for r in rows:
        rep = r[1]
        rep_max = r[2]
        out.append(
            DepthHeatmapRow(
                bucket_intra_ms=int(r[0]),
                ask_prices=tuple(int(rep[k]) for k in _DEPTH_ASK_P_KEYS),
                ask_qtys=tuple(int(rep[k]) for k in _DEPTH_ASK_Q_KEYS),
                bid_prices=tuple(int(rep[k]) for k in _DEPTH_BID_P_KEYS),
                bid_qtys=tuple(int(rep[k]) for k in _DEPTH_BID_Q_KEYS),
                ask_prices_max=tuple(int(rep_max[k]) for k in _DEPTH_ASK_P_KEYS),
                ask_qtys_max=tuple(int(rep_max[k]) for k in _DEPTH_ASK_Q_KEYS),
                bid_prices_max=tuple(int(rep_max[k]) for k in _DEPTH_BID_P_KEYS),
                bid_qtys_max=tuple(int(rep_max[k]) for k in _DEPTH_BID_Q_KEYS),
            )
        )
    return out


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


def _read_peak_wall_streams(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    where: str,
    intra: str,
    trade_seq_expr: str,
) -> tuple[dict[str, list[_WallEvent]], list[_Touch]]:
    """Linear SQL scans → Python streams for the sweep classifier.

    Reuses the (linear) ``cont``/``rep`` bucketing + 10-level unpivot of the old
    query, but materialises only per-level wall events and raw touches — NO
    non-equi join, NO UNBOUNDED window. Everything else happens in Python.
    """
    level_selects: list[str] = []
    for source in ("cont", "rep"):
        for side, price_prefix, qty_prefix in (("ask", "ask_p", "ask_q"), ("bid", "bid_p", "bid_q")):
            for i in range(1, ORDERBOOK_LEVELS + 1):
                level_selects.append(
                    f"SELECT '{side}' AS side, '{source}' AS source, ts_ms, seq, "
                    f"{price_prefix}{i} AS price, {qty_prefix}{i} AS qty, "
                    f"{intra} AS intra_ms, bucket_id "
                    f"FROM {source} WHERE {qty_prefix}{i} > 0"
                )
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
        rep AS (SELECT * FROM cont WHERE rn = 1)
        {" UNION ALL ".join(level_selects)}
        """,
        [str(path)],
    ).fetchall()
    touch_rows = con.execute(
        f"""
        SELECT ts_ms, {trade_seq_expr} AS seq, price
        FROM read_parquet(?)
        WHERE side IN (1, -1) AND price > 0
        """,
        [str(trades_path)],
    ).fetchall()

    streams: dict[str, list[_WallEvent]] = {
        "ask_rep": [], "ask_cont": [], "bid_rep": [], "bid_cont": [],
    }
    for side, source, ts_ms, seq, price, qty, intra_ms, bucket_id in rows:
        streams[f"{side}_{source}"].append(
            _WallEvent(
                ts_ms=int(ts_ms), seq=int(seq or 0), price=int(price), qty=int(qty),
                intra_ms=int(intra_ms), bucket_id=int(bucket_id),
            )
        )
    touches = [
        _Touch(ts_ms=int(ts_ms), seq=int(seq or 0), price=int(price))
        for ts_ms, seq, price in touch_rows
    ]
    return streams, touches


def _peak_candidates(rows: list[_WallEvent], limit: int | None) -> tuple[AskPeakCandidateRow, ...]:
    ranked = sorted(rows, key=_event_rank_key)
    if limit is not None:
        ranked = ranked[:limit]
    return tuple(AskPeakCandidateRow(price=e.price, qty=e.qty, intra_ms=e.intra_ms) for e in ranked)


def _peak_bucket_dedup(classified: list[tuple[_WallEvent, bool]]) -> list[_WallEvent]:
    """Best per (price, bucket_id) — mirrors ``{side}_all_peak_candidates`` price_rn=1."""
    best: dict[tuple[int, int], _WallEvent] = {}
    for e, _touched in classified:
        key = (e.price, e.bucket_id)
        cur = best.get(key)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            best[key] = e
    return list(best.values())


def _peak_scalar(rows: list[_WallEvent]) -> tuple[int, int, int] | None:
    """Rank-1 (price, qty, intra_ms) or None — mirrors an ``... LIMIT 1`` CTE."""
    if not rows:
        return None
    e = min(rows, key=_event_rank_key)
    return (e.price, e.qty, e.intra_ms)


def query_day_ask_bid_peak_dual(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> tuple[AskPeakDualRow | None, BidPeakDualRow | None]:
    """Return ask and bid peak rows for the same day using shared scans.

    Linear-sweep implementation (ADR-0085): the peak-wall lifecycle
    classification that used to run as one heavy non-equi-join SQL now runs as
    two linear SQL scans + a Python sorted sweep with a Fenwick prefix-max tree
    (``_classify_wall_stream``), replacing the O(N·M) join that spilled 356GB /
    took 155s on the worst day. Public signature and returned dataclasses are
    unchanged.
    """
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    trade_seq_expr = "COALESCE(seq, 0)" if _parquet_has_column(con, trades_path, "seq") else "0"
    bounds = [_DEEP_BOOK_SQL]
    if session_open_ms is not None:
        bounds.append(f"{intra} >= {hhmmssms_to_intra_ms_sql(str(int(session_open_ms)))}")
    if session_close_ms is not None:
        bounds.append(f"{intra} <= {hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))}")
    where = " AND ".join(bounds)

    streams, touches = _read_peak_wall_streams(
        con, path=path, trades_path=trades_path, bucket_ms=bucket_ms,
        where=where, intra=intra, trade_seq_expr=trade_seq_expr,
    )

    def _side_row(side: str) -> dict[str, Any] | None:
        rep_classified, rep_distinct = _classify_wall_stream(streams[f"{side}_rep"], touches, side=side)
        cont_classified, cont_distinct = _classify_wall_stream(streams[f"{side}_cont"], touches, side=side)

        all_close = _peak_scalar([e for e, _t in rep_classified])
        all_max = _peak_scalar([e for e, _t in cont_classified])
        if all_close is None or all_max is None:
            return None

        rep_traded = [e for (_p, t), e in rep_distinct.items() if t]
        rep_untraded = [e for (_p, t), e in rep_distinct.items() if not t]
        cont_traded = [e for (_p, t), e in cont_distinct.items() if t]
        cont_untraded = [e for (_p, t), e in cont_distinct.items() if not t]

        return {
            "all_close": all_close,
            "all_max": all_max,
            "traded_close": _peak_scalar(rep_traded),
            "traded_max": _peak_scalar(cont_traded),
            "untraded_close": _peak_scalar(rep_untraded),
            "untraded_max": _peak_scalar(cont_untraded),
            "traded_peaks": _peak_candidates(rep_traded, 3),
            "traded_max_peaks": _peak_candidates(cont_traded, 3),
            "untraded_peaks": _peak_candidates(rep_untraded, 3),
            "untraded_max_peaks": _peak_candidates(cont_untraded, 3),
            "all_peaks": _peak_candidates(_peak_bucket_dedup(rep_classified), None),
            "all_max_peaks": _peak_candidates(_peak_bucket_dedup(cont_classified), None),
        }

    ask = _side_row("ask")
    bid = _side_row("bid")

    ask_row: AskPeakDualRow | None = None
    if ask is not None:
        tc, tm = ask["traded_close"], ask["traded_max"]
        uc, um = ask["untraded_close"], ask["untraded_max"]
        ask_row = AskPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=ask["traded_peaks"], traded_max_peaks=ask["traded_max_peaks"],
            all_price=ask["all_close"][0], all_qty=ask["all_close"][1], all_intra_ms=ask["all_close"][2],
            all_max_price=ask["all_max"][0], all_max_qty=ask["all_max"][1], all_max_intra_ms=ask["all_max"][2],
            all_peaks=ask["all_peaks"], all_max_peaks=ask["all_max_peaks"],
            untraded_price=uc[0] if uc else None, untraded_qty=uc[1] if uc else None,
            untraded_intra_ms=uc[2] if uc else None,
            untraded_max_price=um[0] if um else None, untraded_max_qty=um[1] if um else None,
            untraded_max_intra_ms=um[2] if um else None,
            untraded_peaks=ask["untraded_peaks"], untraded_max_peaks=ask["untraded_max_peaks"],
        )

    bid_row: BidPeakDualRow | None = None
    if bid is not None:
        tc, tm = bid["traded_close"], bid["traded_max"]
        uc, um = bid["untraded_close"], bid["untraded_max"]
        bid_row = BidPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=bid["traded_peaks"], traded_max_peaks=bid["traded_max_peaks"],
            all_price=bid["all_close"][0], all_qty=bid["all_close"][1], all_intra_ms=bid["all_close"][2],
            all_max_price=bid["all_max"][0], all_max_qty=bid["all_max"][1], all_max_intra_ms=bid["all_max"][2],
            all_peaks=bid["all_peaks"], all_max_peaks=bid["all_max_peaks"],
            untraded_price=uc[0] if uc else None, untraded_qty=uc[1] if uc else None,
            untraded_intra_ms=uc[2] if uc else None,
            untraded_max_price=um[0] if um else None, untraded_max_qty=um[1] if um else None,
            untraded_max_intra_ms=um[2] if um else None,
            untraded_peaks=bid["untraded_peaks"], untraded_max_peaks=bid["untraded_max_peaks"],
        )
    return ask_row, bid_row

