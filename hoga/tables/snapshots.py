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
from typing import Any

import duckdb
import polars as pl
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

# Column widths. Prices fit int32 (KR won ≤ ~5M). Quantities and their deltas
# can exceed int32 max (2,147,483,647) for high-volume / limit-locked
# instruments — e.g. 252670 (KODEX inverse) 총잔량 2,366,893,147, and on a 상한가
# lock a single level's qty approaches the total — so ask_q/bid_q, their deltas,
# and the four totals are int64. seq stays int32 (a per-code-per-day counter,
# never near 2.1B). Ordering (ask_p, ask_q, ask_d, bid_p, bid_q, bid_d) is the
# on-disk column order; dict insertion order preserves it. Shared by
# _build_schema (field types) and write_parquet (array types) so the two never
# drift — a mismatch makes pa.table raise.
_LEVEL_COL_TYPES: dict[str, pa.DataType] = {
    "ask_p": pa.int32(),
    "ask_q": pa.int64(),
    "ask_d": pa.int64(),
    "bid_p": pa.int32(),
    "bid_q": pa.int64(),
    "bid_d": pa.int64(),
}
_TOTAL_COLS: tuple[str, ...] = ("tot_ask", "tot_ask_d", "tot_bid", "tot_bid_d")
_TOTAL_TYPE: pa.DataType = pa.int64()


def _build_schema() -> pa.Schema:
    fields: list[pa.Field] = [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
    ]
    for prefix, dtype in _LEVEL_COL_TYPES.items():
        for i in range(1, ORDERBOOK_LEVELS + 1):
            fields.append(pa.field(f"{prefix}{i}", dtype))
    for total in _TOTAL_COLS:
        fields.append(pa.field(total, _TOTAL_TYPE))
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
    for prefix, dtype in _LEVEL_COL_TYPES.items():
        for i in range(ORDERBOOK_LEVELS):
            cols[f"{prefix}{i + 1}"] = pa.array(
                [getattr(o, prefix)[i] for o in rows], type=dtype
            )
    for total in _TOTAL_COLS:
        cols[total] = pa.array([getattr(o, total) for o in rows], type=_TOTAL_TYPE)
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


def write_parquet_frame(df: pl.DataFrame, path: Path) -> None:
    """write_parquet의 컬럼형 등가물 — 프레임은 이미 플랫 스키마 컬럼을 가진다.

    정렬은 리스트 경로와 동일하게 ts_ms 단독 + stable."""
    table = (
        df.sort("ts_ms", maintain_order=True)
        .select([f.name for f in PARQUET_SCHEMA])
        .to_arrow()
        .cast(PARQUET_SCHEMA)
    )
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, table)


def validate_frame(df: pl.DataFrame, *, lenient: bool = False) -> None:
    """validate의 컬럼형 등가물 — 동일 예외 클래스·메시지.

    사다리 검사(비영 부분수열 정렬)를 long-format 윈도우 누적극값으로 벡터화:
    행별로 레벨 순서 cum_max(ask)/cum_min(bid) 대비 하락/상승이 있으면 위반
    (nz != sorted(nz)와 동치 — 뒤의 비영 원소가 앞선 비영 극값을 깨는 경우).
    위반은 실코퍼스에서 0건이 정상이라, 메시지는 위반 행만 재구성한다.
    lenient면 no-op(리스트 경로의 continue와 동일 — 관측 효과 없음).

    NOTE: 중첩 when-체인으로 행내 running-extreme을 만들면 폴라스 식 트리가
    레벨 수에 지수적으로 불어난다(실측 3.3s) — unpivot이 선형이다.
    """
    if lenient or df.height == 0:
        return

    def _first_bad_row(prefix: str, ascending: bool) -> int | None:
        cols = [f"{prefix}{i}" for i in range(1, ORDERBOOK_LEVELS + 1)]
        long = (
            df.with_row_index("_i")
            .select("_i", *cols)
            .unpivot(index="_i", on=cols, variable_name="_lvl", value_name="_p")
            .filter(pl.col("_p") > 0)
            .with_columns(pl.col("_lvl").str.extract(r"(\d+)$").cast(pl.Int64))
            .sort(["_i", "_lvl"])
        )
        run = (
            pl.col("_p").cum_max().over("_i") if ascending
            else pl.col("_p").cum_min().over("_i")
        )
        breach = pl.col("_p") < run if ascending else pl.col("_p") > run
        bad = long.filter(breach)
        return int(bad["_i"].min()) if bad.height else None

    bad_ask = _first_bad_row("ask_p", ascending=True)
    bad_bid = _first_bad_row("bid_p", ascending=False)
    if bad_ask is None and bad_bid is None:
        return
    # 리스트 경로는 행 순서로 돌며 ask를 먼저 검사한다: 더 이른 위반 행이
    # 기준이고, 같은 행이면 ask 메시지가 우선.
    first = min(x for x in (bad_ask, bad_bid) if x is not None)
    row = df.row(first, named=True)
    nz_ask = [row[f"ask_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1) if row[f"ask_p{i}"] > 0]
    if bad_ask == first and nz_ask != sorted(nz_ask):
        raise SnapshotValidationError(f"ask prices not sorted at seq={row['seq']}: {nz_ask}")
    nz_bid = [row[f"bid_p{i}"] for i in range(1, ORDERBOOK_LEVELS + 1) if row[f"bid_p{i}"] > 0]
    raise SnapshotValidationError(f"bid prices not sorted at seq={row['seq']}: {nz_bid}")


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


def _book_indicator_eligible_sql(
    intra_ms_expr: str,
    *,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> str:
    """호가 파생 지표(호가비·총잔량·히트맵·매도/매수 최대벽) 공용 '유효 스냅샷' 술어 (ADR-0062 v3).

    유효 = 연속거래 호가창(``_DEEP_BOOK_SQL``) AND ``session_open <= t <= session_close``.
    open/close는 하드코딩된 시계가 아니라 그 날짜 메타의 실제 세션 경계(HHMMSSmmm native)
    — 수능일 지연 개장·반나절장 조기 마감이 자동 반영된다. None인 바운드는 그 항만 생략하고,
    둘 다 None이면 순수 구조 술어(``_DEEP_BOOK_SQL``)만 남는다. 클라
    ``isIndicatorEligibleBook``(bucketHogaSeries.ts)과 글자 그대로 같은 정의(단일진실원).

    동시호가 3경로가 전부 이 한 술어로 배제된다:
      * **마감 동시호가·장중 VI**: 3호가 붕괴 → 구조 술어(``_DEEP_BOOK_SQL``)가 배제.
      * **개장 동시호가**(08:50~09:00): hogaplay 실측(2026-07-11, 무작위 40파일 개장 전
        36,371행 전수)상 이 역시 3호가 붕괴책이라 구조 술어가 이미 배제한다. ``session_open``
        하한은 라이브 KIS WS 개장 전 호가가 10레벨일 가능성(PR #96 제보 정황; 장중 미실측)에
        대한 안전망 — 과거 데이터에는 중복이라 무해.
      * **마감 교차 후 호가창 재확장**(~15:30:14 > close): ``session_close`` 상한이 배제.
        종전 호가비/히트맵이 쓰던 ``<= last_continuous_ms`` 간접층(파일 전체 max 사전 스캔)과
        수학적 동치 — {deep 행 중 close 이하} = {deep 행 중 last_continuous 이하} — 이므로
        v3에서 간접층을 제거하고 매도벽과 같은 직접 close 상한으로 통일했다.
    """
    parts = [_DEEP_BOOK_SQL]
    if session_open_ms is not None:
        parts.append(f"{intra_ms_expr} >= {hhmmssms_to_intra_ms_sql(str(int(session_open_ms)))}")
    if session_close_ms is not None:
        parts.append(f"{intra_ms_expr} <= {hhmmssms_to_intra_ms_sql(str(int(session_close_ms)))}")
    return " AND ".join(parts)


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


# ── Peak-wall columnar sweep classifier (ADR-0085 v2) ────────────────────────
#
# History: the single-SQL classifier (ADR-0084) materialised a non-equi join —
# 17GB RSS / 155s on the worst day (20260623/000660). ADR-0085 replaced it with
# a pure-Python Fenwick sweep over ``_WallEvent`` dataclass streams (identical
# semantics, O((N+M) log M)) — but materialising ~2M dataclasses cost ~1GB RSS
# and ~6s on a heavy day (measured 034020/20260116), and the pure-Python sweep
# is GIL-bound, so concurrent computes serialise (12-way: 94s wall vs 77s
# sequential — measured 2026-07-11).
#
# This columnar version keeps the exact sweep semantics but moves the data
# plane to polars (Rust, GIL-released): DuckDB → Arrow → polars frames,
# is_touched as a merged-timeline reverse cumulative extreme, and all
# ranking/dedup reductions as frame ops. No Python loop remains.
#
# Semantics contract (must match the ADR-0085 sweep exactly; oracle-tested in
# tests/test_peak_sweep_oracle.py against a frozen copy):
#   rank       — qty DESC, intra_ms ASC, seq ASC, price ASC.
#   is_touched — event ``e`` is touched iff some touch with ``(ts, seq) >= e``'s
#                dominates it price-wise (ask: ``touch.price >= e.price``;
#                bid: ``<=``). Same-``(ts, seq)`` touches ARE included.
#
# lifecycle 세그먼트(엄격히-이른 지배 터치 기준 분할, ADR-0085의 Fenwick pass 2)는
# 계산하지 않는다 — 최종 출력에 잉여임이 증명되어 삭제했다 (ADR-0085 v2.1):
#
#   정리: 모든 (price, lifecycle) 세그먼트는 touched 값이 순수하다.
#   증명: 가격 p의 지배 터치들을 키 순서로 d_1 < d_2 < … < d_K라 하자.
#     count(e) = |{ d_i < key(e) }| 는 세그먼트 키와 동치다(둘 다 "사이에 지배
#     터치가 없는" 이벤트를 같은 그룹으로 묶는다). count(e) = c < K 이면
#     d_{c+1} ≥ key(e) 가 존재 → touched. count(e) = K 이면 모든 d_i < key(e)
#     → 어떤 지배 터치도 ≥ key(e) 가 아님 → untouched. ∎
#   따름정리: distinct_best[(p, X)] = "클래스 X 이벤트 전역 rank-1"
#     (순수 세그먼트들의 세그먼트-최댓값들의 최댓값 = 클래스 전역 최댓값).
#   → per-event lifecycle id가 불필요하고, per-(price,lifecycle) 중간 dedup도
#   per-(price,touched) rank-1로 직접 붕괴한다. 동결 오라클(퍼즈 + 실데이터)이
#   이 동치를 경험적으로 재확인한다.

_PEAK_RANK_BY = ["qty", "intra_ms", "seq", "price"]
_PEAK_RANK_DESC = [True, False, False, False]


def _peak_rank_sort(df: pl.DataFrame) -> pl.DataFrame:
    """SQL 공통 랭킹 정렬: qty DESC, intra_ms ASC, seq ASC, price ASC."""
    return df.sort(_PEAK_RANK_BY, descending=_PEAK_RANK_DESC)


def _classify_wall_frame(
    events: pl.DataFrame,
    touches: pl.DataFrame,
    *,
    side: str,
) -> pl.DataFrame:
    """Columnar sweep: ``events`` + ``touched`` column.

    ``events`` needs columns ts_ms/seq/price/qty/intra_ms/bucket_id (Int64);
    ``touches`` needs ts_ms/seq/price (Int64). Both may arrive unsorted.
    """
    is_ask = side == "ask"
    ev = events.sort(["ts_ms", "seq"])
    n = ev.height
    if n == 0:
        return ev.with_columns(pl.lit(False).alias("touched"))
    tch = touches.sort(["ts_ms", "seq", "price"])

    # is_touched via merged-timeline reverse cumulative extreme.
    # Event rows (kind=0) sort BEFORE same-(ts,seq) touch rows (kind=1), so the
    # suffix extreme at an event row includes same-key touches — the oracle's
    # ``(t.ts, t.seq) >= (e.ts, e.seq)`` inclusion. cum_max/cum_min accumulate
    # across nulls but leave null positions null → forward_fill carries the
    # running extreme onto event rows.
    merged = pl.concat([
        ev.select(
            "ts_ms", "seq",
            pl.lit(0, pl.Int8).alias("kind"),
            pl.lit(None, pl.Int64).alias("tprice"),
            pl.int_range(0, pl.len(), dtype=pl.Int64).alias("eidx"),
        ),
        tch.select(
            "ts_ms", "seq",
            pl.lit(1, pl.Int8).alias("kind"),
            pl.col("price").alias("tprice"),
            pl.lit(None, pl.Int64).alias("eidx"),
        ),
    ]).sort(["ts_ms", "seq", "kind"])
    rev = merged["tprice"].reverse()
    rev = (rev.cum_max() if is_ask else rev.cum_min()).forward_fill()
    fut = (
        merged.with_columns(rev.reverse().alias("fut"))
        .filter(pl.col("kind") == 0)
        .sort("eidx")["fut"]
    )
    touched = (fut >= ev["price"]) if is_ask else (fut <= ev["price"])
    touched = touched.fill_null(False)

    return ev.with_columns(touched.alias("touched"))


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
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> list[QuoteRatioRow]:
    """Bucket snapshots and emit the depth totals of the representative snapshot per bucket.

    For each bucket, ``ask_total`` / ``bid_total`` are the SUM across all 10
    ask_q / bid_q level columns of the bucket's representative snapshot.

    The representative is the last *continuous-trading* snapshot inside the
    session. A snapshot is eligible (``is_pre``) iff it is a continuous-trading
    book (depth beyond level 3 on both sides, ``_DEEP_BOOK_SQL``) AND its time is
    within ``[session_open, session_close]`` — the shared ``_book_indicator_
    eligible_sql`` predicate (ADR-0062 v3), identical to 매도/매수 최대벽 and the
    client ``isIndicatorEligible``. Within a bucket, is_pre rows outrank non-is_pre
    rows for the representative pick, falling back to the last overall row when a
    bucket has none (fully inside an auction window, left for the display Auction
    Mask, ADR-0029). The structural (deep-book) test replaces the prior
    ``session_close - 10min`` clock, which mis-sliced the tail bucket when the real
    continuous→auction transition drifted off 15:20:00 (observed 15:20:01.xx). The
    ``<= session_close`` bound is load-bearing: every stock shows a post-cross book
    re-expansion (~15:30:14) that would otherwise leak past the auction; the
    ``>= session_open`` bound excludes the opening auction (ADR-0062 v3, matching
    매도벽). When ``session_close_ms`` is None OR the file has no in-session deep
    book at all (aggregation-unit tests / degenerate captures) the predicate is
    the constant TRUE — plain last-in-bucket, and the ``session_open_ms`` bound
    is deliberately NOT applied either (don't blank a degenerate series). See
    ADR-0062.

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
    last_continuous_ms = (
        _last_continuous_intra_ms(con, path=path, session_close_ms=session_close_ms)
        if session_close_ms is not None
        else None
    )
    if last_continuous_ms is None:
        # 세션 바운드 없음 OR 세션 내 deep book 전무(퇴화 fixture/깨진 캡처) — 시리즈를
        # 통째로 비우지 않고 last-in-bucket 폴백을 유지한다(ADR-0062). 실데이터는 항상
        # 세션 바운드 + deep book이라 이 분기는 집계 단위 테스트/퇴화 데이터에서만 발화한다.
        pre_auction_pred = "TRUE"
    else:
        # ADR-0062 v3 (동시호가 배제 통일): 매도벽·히트맵과 글자 그대로 같은 공용 술어 —
        # 구조(마감·VI·개장 3호가 붕괴) AND open ≤ t ≤ close. deep book이 존재하는 이
        # 분기에서 `<= session_close`는 종전 `<= last_continuous`와 수학적 동치다.
        pre_auction_pred = _book_indicator_eligible_sql(
            intra_ms_expr, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )
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
class DailyDepthPeak:
    """하루치 매도/매수 총잔량(10단계 합)의 당일 최댓값 + 유효 스냅샷 수.

    ``ask_peak`` / ``bid_peak`` = 유효(연속거래+세션내, ``_book_indicator_eligible_sql``)
    스냅샷 전체에서 ``SUM(ask_q1..10)`` / ``SUM(bid_q1..10)``의 당일 최댓값. 이는
    query_bucketed_ratio가 pane에 그리는 Intra-Bar Max(``ask_max``, ADR-0076)를 하루
    단위로 collapse한 값과 동일 — 스크리너 depth peak 조건이 /live 총잔량 pane의
    intra-bar-max 레벨선과 숫자로 일치하도록 같은 술어를 재사용한다.

    ``eligible_count`` = 술어를 통과한 스냅샷 수(0이면 유효 데이터 없음 → peak는 None).
    """

    ask_peak: int
    bid_peak: int
    eligible_count: int


def query_daily_depth_peak(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> DailyDepthPeak | None:
    """유효 스냅샷의 10단계 매도/매수 총잔량 당일 최댓값을 스칼라로 반환.

    술어는 query_bucketed_ratio와 글자 그대로 같은 ``_book_indicator_eligible_sql``
    (ADR-0062 v3: 연속거래 호가창 AND session_open ≤ t ≤ session_close). 버킷팅은
    하지 않는다 — pane은 분단위 표시를 위해 버킷이 필요하지만 "당일 peak"는 유효
    스냅샷 전체의 단일 최댓값이면 충분하고, 그 값은 pane의 분봉 Intra-Bar Max를
    하루로 collapse한 것과 같다.

    ``session_close_ms``가 None이거나 파일에 세션내 deep book이 전무하면(퇴화
    fixture/깨진 캡처) query_bucketed_ratio와 동일하게 술어를 TRUE로 완화한다.
    유효 행이 하나도 없으면(MAX가 NULL) None을 반환 — 호출자는 이를 "그 날 유효
    총잔량 데이터 없음"으로 취급한다(빈 parquet도 None).
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    last_continuous_ms = (
        _last_continuous_intra_ms(con, path=path, session_close_ms=session_close_ms)
        if session_close_ms is not None
        else None
    )
    if last_continuous_ms is None:
        pre_auction_pred = "TRUE"
    else:
        pre_auction_pred = _book_indicator_eligible_sql(
            intra_ms_expr, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )
    row = con.execute(
        f"""
        SELECT max({_ASK_Q_SUM}) AS ask_peak,
               max({_BID_Q_SUM}) AS bid_peak,
               count(*) AS eligible_count
        FROM read_parquet(?)
        WHERE ({pre_auction_pred})
        """,
        [str(path)],
    ).fetchone()
    if row is None or row[0] is None:
        return None
    return DailyDepthPeak(
        ask_peak=int(row[0]), bid_peak=int(row[1]), eligible_count=int(row[2]),
    )


@dataclass(frozen=True)
class DepthHeatmapRow:
    """버킷 대표(마지막 연속거래) 스냅샷의 10단계 매도/매수 가격·잔량.

    ``bucket_intra_ms``는 LINEAR ms-from-midnight (NOT raw HHMMSSmmm, NOT unix
    ms) — 호출자가 ``ms_from_midnight_to_unix_ms(date, bucket_intra_ms)``로 unix
    변환. QuoteRatioRow.bucket_intra_ms와 동일 규약. 대표 선택 규칙도
    query_bucketed_ratio와 동일.

    ``ask_prices``/``ask_qtys``는 index 0 = 최우선(best) 호가. 유효 스냅샷(연속거래
    +세션내)이 하나도 없는 완전-동시호가 버킷은 결과에서 통째로 빠진다(ADR-0062 v3
    — 매도벽의 "사전 필터→자연 탈락"과 동일; 종전의 last-in-bucket 폴백 방출 폐기).

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
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> list[DepthHeatmapRow]:
    """버킷별 대표 스냅샷의 10단계 가격·잔량을 방출한다.

    대표 = 마지막 연속거래 스냅샷(query_bucketed_ratio와 동일 정의). 40개 레벨
    컬럼을 하나의 struct_pack으로 묶어 arg_max(rep_key)로 한 물리 행에서 함께
    가져온다 — 총잔량 대신 개별 레벨을 보존하는 것만 다르다. Empty parquet → [].

    ADR-0062 v3: 공용 술어 ``_book_indicator_eligible_sql``(구조+세션 경계)로 유효
    스냅샷만 WHERE 사전 필터한다 — 매도벽과 동일 패턴. 필터 뒤 남는 행은 모두 유효라
    대표는 그냥 버킷의 마지막 행(``rep_key = intra_ms``)이고, 유효 행이 없는 완전-
    동시호가 버킷(마감·장중 VI·개장 동시호가)은 GROUP BY에서 자연 탈락한다(종전
    is_pre CASE + last-in-bucket 폴백 방출을 대체 — 프론트 라이브 빌더와 파리티).

    ``*_max`` 필드는 버킷 내 총잔량(bid+ask 10레벨 합)이 최대였던 스냅샷의 40컬럼
    (캔들 고가처럼 "분봉 내 최댓값 기준"). 사전 필터로 유효 행만 남으므로 정렬 키는
    ``total`` 단독이다(종전 struct_pack(is_pre, total)의 is_pre 우선 정렬은 이제 불필요).
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    last_continuous_ms = (
        _last_continuous_intra_ms(con, path=path, session_close_ms=session_close_ms)
        if session_close_ms is not None
        else None
    )
    if last_continuous_ms is None:
        # 세션 바운드 없음 OR 세션 내 deep book 전무(퇴화 fixture) — 사전 필터 없이
        # last-in-bucket 폴백(호가비와 동일). 실데이터 미발화.
        where_pred = "TRUE"
    else:
        # ADR-0062 v3 (동시호가 배제 통일): 호가비·매도벽과 글자 그대로 같은 공용 술어.
        where_pred = _book_indicator_eligible_sql(
            intra_ms_expr, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )

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
                 ({intra_ms_expr}) AS rep_key,
                 (({_BID_Q_SUM}) + ({_ASK_Q_SUM})) AS total,
                 {passthrough_cols}
          FROM read_parquet(?)
          WHERE {where_pred}
        )
        SELECT bucket * {bucket_ms} AS bucket_intra_ms,
               arg_max(struct_pack({struct_body}), rep_key) AS rep,
               arg_max(struct_pack({struct_body}), total) AS rep_max
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


@dataclass(frozen=True)
class DepthDeltaBucket:
    """한 분봉 버킷의 단별 잔량 증감 + 그 버킷에서 관측된 호가단위.

    ``ask``/``bid``는 (price, in_qty, out_qty) — in ≥ 0(유입 합), out ≤ 0(유출 합).
    증감 0 가격은 담지 않는다. ``*_tick``은 셀 높이용 호가단위(관측 불가 시 0) —
    프론트 DepthDeltaPoint.askTick/bidTick 계약과 동일.
    """

    bucket_intra_ms: int
    ask: tuple[tuple[int, int, int], ...]
    bid: tuple[tuple[int, int, int], ...]
    ask_tick: int
    bid_tick: int


# 증감 diff 체인의 시간 상한. 연속된 두 유효 스냅샷의 간격이 이보다 크면 diff 하지
# 않는다(체인 차단). 캡처 주기 실측 중앙값 ~10s 의 6배 — (a) 장중 VI/동시호가로
# WHERE 가 걸러낸 구간을 건너뛰는 diff(관측창 대이동 아티팩트), (b) UN 캡처의
# KRX→NXT venue 스왑 경계(15:20 마감동시호가 ~ 15:30+, 항상 수분 갭), (c) 캡처
# 중단 구간(실측 최대 67분)을 전부 하나의 규칙으로 차단한다. 프론트 라이브 빌더의
# "ineligible/venue 전환 시 prev=null" 리셋과 의미상 동일한 역할(스냅샷에 venue
# 컬럼이 없어 시간 갭이 유일한 프록시다).
DEPTH_DELTA_MAX_GAP_MS = 60_000


def query_bucketed_depth_delta(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
    max_gap_ms: int = DEPTH_DELTA_MAX_GAP_MS,
) -> list[DepthDeltaBucket]:
    """연속 스냅샷 diff → 버킷별 가격별 유입/유출 합 (단별 잔량 증감 지표의 과거 소스).

    프론트 라이브 빌더(bucketDepthDelta)와 같은 규칙의 서버판:
      * **매도는 매도끼리, 매수는 매수끼리** diff — side 를 합치면 현재가 이동 시
        같은 가격이 매도단→매수단으로 넘어간 것(무관한 주문)을 연속으로 오인한다.
      * **두 스냅샷 공통 가격만** diff (INNER JOIN ON price) — 10단 관측창이 현재가를
        따라 미끄러질 때 창에 드나드는 가격의 잔량은 주문 변화가 아니라 관측창 이동
        아티팩트다. price=0(빈 슬롯)도 자연 배제.
      * **체인 차단**: 유효 스냅샷(공용 술어 ``_book_indicator_eligible_sql``, ADR-0062
        v3)만 diff 하고, 인접 유효 쌍의 간격이 ``max_gap_ms`` 를 넘으면 제외
        (``DEPTH_DELTA_MAX_GAP_MS`` 주석 참조).

    ⚠️ 저장된 ``ask_d*``/``bid_d*`` 컬럼을 쓰지 않는 이유: kiwoom_live 프로모션이
    전부 0 으로 채우는 hogaplay 시절 스키마 잔재이고(promote.py `_ZERO_LEVELS`),
    소스가 채우더라도 "송신 스냅샷의 직전 1스텝"이라 절사된 push 사이의 전환을
    누적하지 않는다 — 합산해도 실제 변화가 안 나온다(2026-07-20 0D FID 실채록,
    docs/research/2026-07-20-kiwoom-0d-delta-fid-semantics.md). 잔량 절대값의 연속
    diff 는 텔레스코핑으로 net 이 정확하다.

    캡처 주기(~10s)로 인해 유입/유출 gross 는 **하한선**이다 — 10초 안에 생겼다
    사라진 벽은 보이지 않는다. net 은 표본 간격과 무관하게 정확하다.

    ``*_tick`` 은 버킷 내 유효 스냅샷들의 사다리 가격 합집합에서 인접 간격의
    중앙값 — 호가단위 경계를 걸친 사다리에서 최솟값을 쓰면 넓은 쪽 셀이 절반
    높이가 되는 것을 피한다(프론트 ladderTick 과 같은 선택).
    """
    intra_ms_expr = hhmmssms_to_intra_ms_sql("ts_ms")
    last_continuous_ms = (
        _last_continuous_intra_ms(con, path=path, session_close_ms=session_close_ms)
        if session_close_ms is not None
        else None
    )
    if last_continuous_ms is None:
        where_pred = "TRUE"
    else:
        where_pred = _book_indicator_eligible_sql(
            intra_ms_expr, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
        )

    level_cols = ", ".join(
        f"ask_p{i}, ask_q{i}, bid_p{i}, bid_q{i}" for i in range(1, ORDERBOOK_LEVELS + 1)
    )
    pair_cols = ", ".join(
        f"cur.{c} AS c_{c}, prev.{c} AS p_{c}"
        for i in range(1, ORDERBOOK_LEVELS + 1)
        for c in (f"ask_p{i}", f"ask_q{i}", f"bid_p{i}", f"bid_q{i}")
    )
    cur_arms = " UNION ALL ".join(
        f"SELECT n, bucket, '{side}' AS side, c_{side}_p{i} AS price, c_{side}_q{i} AS qty FROM pairs"
        for i in range(1, ORDERBOOK_LEVELS + 1)
        for side in ("ask", "bid")
    )
    prev_arms = " UNION ALL ".join(
        f"SELECT n, '{side}' AS side, p_{side}_p{i} AS price, p_{side}_q{i} AS qty FROM pairs"
        for i in range(1, ORDERBOOK_LEVELS + 1)
        for side in ("ask", "bid")
    )
    eligible_cte = f"""
        eligible AS (
          SELECT ({intra_ms_expr}) AS t,
                 row_number() OVER (ORDER BY ({intra_ms_expr}), seq) AS n,
                 {level_cols}
          FROM read_parquet(?)
          WHERE {where_pred}
        )
    """

    delta_rows = con.execute(
        f"""
        WITH {eligible_cte},
        pairs AS (
          SELECT cur.n AS n, (cur.t // {bucket_ms}) AS bucket, {pair_cols}
          FROM eligible cur JOIN eligible prev ON prev.n = cur.n - 1
          WHERE cur.t - prev.t <= {max_gap_ms}
        ),
        cur_lv AS ({cur_arms}),
        prev_lv AS ({prev_arms}),
        joined AS (
          SELECT c.bucket, c.side, c.price, (c.qty - p.qty) AS d
          FROM cur_lv c
          JOIN prev_lv p ON p.n = c.n AND p.side = c.side AND p.price = c.price
          WHERE c.price > 0 AND (c.qty - p.qty) != 0
        )
        SELECT bucket * {bucket_ms} AS bucket_intra_ms, side, price,
               sum(CASE WHEN d > 0 THEN d ELSE 0 END) AS in_qty,
               sum(CASE WHEN d < 0 THEN d ELSE 0 END) AS out_qty
        FROM joined
        GROUP BY 1, 2, 3
        ORDER BY 1, 2, 3
        """,
        [str(path)],
    ).fetchall()
    if not delta_rows:
        return []

    # 버킷×side 별 호가단위 — 유효 스냅샷 전체(diff 쌍 아님)의 사다리 합집합 기준.
    tick_arms = " UNION ALL ".join(
        f"SELECT (t // {bucket_ms}) AS bucket, '{side}' AS side, {side}_p{i} AS price FROM eligible"
        for i in range(1, ORDERBOOK_LEVELS + 1)
        for side in ("ask", "bid")
    )
    tick_rows = con.execute(
        f"""
        WITH {eligible_cte},
        lv AS ({tick_arms}),
        uniq AS (SELECT DISTINCT bucket, side, price FROM lv WHERE price > 0),
        gaps AS (
          SELECT bucket, side,
                 price - lag(price) OVER (PARTITION BY bucket, side ORDER BY price) AS g
          FROM uniq
        )
        SELECT bucket * {bucket_ms} AS bucket_intra_ms, side,
               CAST(median(g) AS BIGINT) AS tick
        FROM gaps
        WHERE g IS NOT NULL AND g > 0
        GROUP BY 1, 2
        """,
        [str(path)],
    ).fetchall()
    ticks: dict[tuple[int, str], int] = {
        (int(b), str(side)): int(t) for b, side, t in tick_rows
    }

    grouped: OrderedDict[int, dict[str, list[tuple[int, int, int]]]] = OrderedDict()
    for b, side, price, in_q, out_q in delta_rows:
        entry = grouped.setdefault(int(b), {"ask": [], "bid": []})
        entry[str(side)].append((int(price), int(in_q), int(out_q)))
    return [
        DepthDeltaBucket(
            bucket_intra_ms=b,
            ask=tuple(sides["ask"]),
            bid=tuple(sides["bid"]),
            ask_tick=ticks.get((b, "ask"), 0),
            bid_tick=ticks.get((b, "bid"), 0),
        )
        for b, sides in grouped.items()
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

    동시호가 배제는 공용 술어 ``_book_indicator_eligible_sql``(호가비·히트맵과 동일)
    한 곳으로 통일 — 구조(마감·VI·개장 동시호가 3-레벨 붕괴) AND open ≤ t ≤ close.
    ``session_open_ms`` 하한은 개장 동시호가, ``session_close_ms`` 상한은 마감 교차 후
    호가창 재확장(~15:30:14) 유입을 막는다.

    동률이면 가장 이른 시각. 빈 parquet(또는 세션 내 연속거래행 없음) → None. 파일 부재
    가드는 호출자(bundle) 책임. ``bucket_ms``는 > 0 (호출자 validate_bucket_ms 책임)."""
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    where = _book_indicator_eligible_sql(
        intra, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )
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
    where = _book_indicator_eligible_sql(
        intra, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )

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


def _read_peak_wall_frames(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    where: str,
    intra: str,
    trade_seq_expr: str,
) -> tuple[pl.DataFrame, pl.DataFrame]:
    """Linear SQL scans → polars frames for the columnar sweep classifier.

    Reuses the (linear) ``cont``/``rep`` bucketing + 10-level unpivot of the old
    query, but fetches via Arrow into columnar frames — NO per-row Python
    objects (the ADR-0085 dataclass streams cost ~1GB RSS on a heavy day),
    NO non-equi join, NO UNBOUNDED window.
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
    events = con.execute(
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
    ).pl()
    touches = con.execute(
        f"""
        SELECT ts_ms, {trade_seq_expr} AS seq, price
        FROM read_parquet(?)
        WHERE side IN (1, -1) AND price > 0
        """,
        [str(trades_path)],
    ).pl()

    num_cols = ["ts_ms", "seq", "price", "qty", "intra_ms", "bucket_id"]
    events = events.with_columns(
        [pl.col(c).fill_null(0).cast(pl.Int64) for c in num_cols]
        # 2M행 Utf8 두 컬럼은 정렬·복사 비용이 지배적 — 사전형으로 격하.
        + [pl.col("side").cast(pl.Categorical), pl.col("source").cast(pl.Categorical)],
    )
    touches = touches.with_columns(
        [pl.col(c).fill_null(0).cast(pl.Int64) for c in ("ts_ms", "seq", "price")],
    )
    return events, touches


def _peak_candidates(df: pl.DataFrame, limit: int | None) -> tuple[AskPeakCandidateRow, ...]:
    ranked = _peak_rank_sort(df)
    if limit is not None:
        ranked = ranked.head(limit)
    return tuple(
        AskPeakCandidateRow(price=p, qty=q, intra_ms=i)
        for p, q, i in zip(ranked["price"], ranked["qty"], ranked["intra_ms"], strict=True)
    )


def _peak_bucket_dedup(df: pl.DataFrame) -> pl.DataFrame:
    """Best per (price, bucket_id) — mirrors ``{side}_all_peak_candidates`` price_rn=1."""
    return _peak_rank_sort(df).unique(
        subset=["price", "bucket_id"], keep="first", maintain_order=True,
    )


def _peak_scalar(df: pl.DataFrame) -> tuple[int, int, int] | None:
    """Rank-1 (price, qty, intra_ms) or None — mirrors an ``... LIMIT 1`` CTE."""
    if df.height == 0:
        return None
    row = _peak_rank_sort(df).row(0, named=True)
    return (row["price"], row["qty"], row["intra_ms"])


def _peak_distinct(classified: pl.DataFrame) -> pl.DataFrame:
    """Best per (price, touched) — mirrors ``{side}_{src}_lifecycle_distinct``.

    구 구현의 per-(price, lifecycle) 중간 dedup은 생략한다: 세그먼트가 touched
    순수(모듈 헤더의 정리)이므로 클래스 전역 rank-1과 결과가 동일하다. 동결
    오라클(lifecycle 기계 포함)과의 전 필드 일치가 이 동치의 경험적 재확인."""
    return _peak_rank_sort(classified).unique(
        subset=["price", "touched"], keep="first", maintain_order=True,
    )


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

    Columnar-sweep implementation (ADR-0085 v2/v2.1): two linear SQL scans
    fetched into polars frames + a fully columnar classifier
    (``_classify_wall_frame``) — no Python loop. The lifecycle segmentation of
    the original sweep is provably redundant to the output (see the module
    header theorem) and is not computed. Identical results to the ADR-0085
    dataclass sweep (oracle-tested), GIL-released end to end. Public signature
    and returned dataclasses are unchanged.
    """
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    trade_seq_expr = "COALESCE(seq, 0)" if _parquet_has_column(con, trades_path, "seq") else "0"
    where = _book_indicator_eligible_sql(
        intra, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )

    events, touches = _read_peak_wall_frames(
        con, path=path, trades_path=trades_path, bucket_ms=bucket_ms,
        where=where, intra=intra, trade_seq_expr=trade_seq_expr,
    )

    def _side_row(side: str) -> dict[str, Any] | None:
        classified = _classify_wall_frame(
            events.filter(pl.col("side") == side), touches, side=side,
        )
        rep = classified.filter(pl.col("source") == "rep")
        cont = classified.filter(pl.col("source") == "cont")

        all_close = _peak_scalar(rep)
        all_max = _peak_scalar(cont)
        if all_close is None or all_max is None:
            return None

        rep_distinct = _peak_distinct(rep)
        cont_distinct = _peak_distinct(cont)
        rep_traded = rep_distinct.filter(pl.col("touched"))
        rep_untraded = rep_distinct.filter(~pl.col("touched"))
        cont_traded = cont_distinct.filter(pl.col("touched"))
        cont_untraded = cont_distinct.filter(~pl.col("touched"))

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
            "all_peaks": _peak_candidates(_peak_bucket_dedup(rep), None),
            "all_max_peaks": _peak_candidates(_peak_bucket_dedup(cont), None),
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

