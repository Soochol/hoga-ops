"""Oracle equivalence for the peak-wall sweep rewrite (ADR-0085 v2).

Frozen copy of the pre-vectorization pure-Python implementation (dataclass
streams + Fenwick sweep, as merged in ADR-0085) serves as the ORACLE. The
rewritten production ``query_day_ask_bid_peak_dual`` must produce identical
rows on:

  * seeded fuzz books/trades (many shapes: touches at same (ts,seq), lifecycle
    reopen, collapsed books, session bounds, empty touches), and
  * optionally real captured days (env ``HOGA_ORACLE_REAL_DIR`` — manual run).

If prod and oracle ever diverge, the failing seed pins the repro.
"""
from __future__ import annotations

import os
import random
from bisect import bisect_left, bisect_right
from dataclasses import dataclass
from pathlib import Path

import duckdb
import pytest

from hoga.tables.snapshots import (
    ORDERBOOK_LEVELS,
    AskPeakCandidateRow,
    AskPeakDualRow,
    BidPeakDualRow,
    Orderbook,
    _book_indicator_eligible_sql,
    _parquet_has_column,
    hhmmssms_to_intra_ms_sql,
    query_day_ask_bid_peak_dual,
    write_parquet,
)
from hoga.tables.trades import Trade, write_parquet as write_trades

# ─────────────────────────────────────────────────────────────────────────────
# ORACLE — frozen pre-vectorization implementation. Do not "fix" or refactor;
# byte-for-byte semantics of the ADR-0085 sweep is the whole point.
# ─────────────────────────────────────────────────────────────────────────────


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
    return (-e.qty, e.intra_ms, e.seq, e.price)


class _MaxFenwick:
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
    is_ask = side == "ask"
    events_sorted = sorted(events, key=lambda e: (e.ts_ms, e.seq))
    touches_sorted = sorted(touches, key=lambda t: (t.ts_ms, t.seq, t.price))

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

    uniq = sorted({t.price for t in touches_sorted})
    fen = _MaxFenwick(len(uniq))
    if is_ask:
        def _touch_idx(price: int) -> int:
            return len(uniq) - bisect_left(uniq, price)

        _query_idx = _touch_idx
    else:
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
    best: dict[tuple[int, int], _WallEvent] = {}
    for e, _touched in classified:
        key = (e.price, e.bucket_id)
        cur = best.get(key)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            best[key] = e
    return list(best.values())


def _peak_scalar(rows: list[_WallEvent]) -> tuple[int, int, int] | None:
    if not rows:
        return None
    e = min(rows, key=_event_rank_key)
    return (e.price, e.qty, e.intra_ms)


def oracle_query_day_ask_bid_peak_dual(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    session_open_ms: int | None = None,
    session_close_ms: int | None = None,
) -> tuple[AskPeakDualRow | None, BidPeakDualRow | None]:
    intra = hhmmssms_to_intra_ms_sql("ts_ms")
    trade_seq_expr = "COALESCE(seq, 0)" if _parquet_has_column(con, trades_path, "seq") else "0"
    where = _book_indicator_eligible_sql(
        intra, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )

    streams, touches = _read_peak_wall_streams(
        con, path=path, trades_path=trades_path, bucket_ms=bucket_ms,
        where=where, intra=intra, trade_seq_expr=trade_seq_expr,
    )

    def _side_row(side: str) -> dict | None:
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


# ─────────────────────────────────────────────────────────────────────────────
# Fuzz generation — seeded, deterministic.
# ─────────────────────────────────────────────────────────────────────────────


def _fuzz_day(rng: random.Random) -> tuple[list[Orderbook], list[Trade]]:
    """Random but plausible day: books on a shared price grid + trades that
    sometimes touch walls, sometimes at the exact same (ts_ms, seq) as a book.
    """
    base = rng.randrange(10_000, 60_000, 50)
    grid = [base + 50 * i for i in range(-15, 25)]  # 40 entries; mid=15
    n_books = rng.randrange(3, 40)
    n_trades = rng.randrange(0, 60)

    books: list[Orderbook] = []
    ts = 90_000_000 + rng.randrange(0, 1000) * 500
    seq = 1
    z = tuple([0] * 10)
    for _ in range(n_books):
        ts += rng.randrange(1, 30) * 500
        seq += rng.randrange(1, 5)
        a0 = rng.randrange(1, 13)
        # ask 인덱스 15+a0-1 .. 15+a0+8 ≤ 35 < 40, bid 인덱스 ≥ 15+1-2-9 = 5 ≥ 0.
        ask_p = tuple(grid[15 + a0 - 1 + i] for i in range(10))
        bid_p = tuple(grid[15 + a0 - 2 - i] for i in range(10))
        # 붕괴책 혼입: 가끔 상위레벨만 채워 eligibility 필터 경로도 태운다.
        depth = rng.choice([10, 10, 10, 3, 1])
        ask_q = tuple(rng.randrange(0, 5000) if i < depth else 0 for i in range(10))
        bid_q = tuple(rng.randrange(0, 5000) if i < depth else 0 for i in range(10))
        books.append(Orderbook(
            ts_ms=ts, seq=seq, ask_p=ask_p, ask_q=ask_q, ask_d=z,
            bid_p=bid_p, bid_q=bid_q, bid_d=z,
            tot_ask=sum(ask_q), tot_ask_d=0, tot_bid=sum(bid_q), tot_bid_d=0,
        ))

    trades: list[Trade] = []
    for _ in range(n_trades):
        if books and rng.random() < 0.25:
            # 동일 (ts_ms, seq) 체결 — same-key touch 엣지(>= vs strictly-earlier).
            b = rng.choice(books)
            t_ts, t_seq = b.ts_ms, b.seq
        else:
            t_ts = 90_000_000 + rng.randrange(0, 4000) * 250
            t_seq = rng.randrange(1, 200)
        trades.append(Trade(
            ts_ms=t_ts, seq=t_seq, price=rng.choice(grid), change_pct=0, qty=1,
            side=rng.choice([1, -1, 1, -1, 0]),  # side=0 혼입 → WHERE side IN (1,-1) 확인
            cum_vol=1, cum_trades=1, low_so_far=base, high_so_far=base,
            net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0,
        ))
    return books, trades


def _compare_day(tmp_path: Path, books: list[Orderbook], trades: list[Trade],
                 bucket_ms: int, session: tuple[int | None, int | None]) -> None:
    snap = tmp_path / "snapshots.parquet"
    tr = tmp_path / "trades.parquet"
    write_parquet(books, snap)
    write_trades(trades, tr)
    con = duckdb.connect()
    open_ms, close_ms = session
    expected = oracle_query_day_ask_bid_peak_dual(
        con, path=snap, trades_path=tr, bucket_ms=bucket_ms,
        session_open_ms=open_ms, session_close_ms=close_ms,
    )
    actual = query_day_ask_bid_peak_dual(
        con, path=snap, trades_path=tr, bucket_ms=bucket_ms,
        session_open_ms=open_ms, session_close_ms=close_ms,
    )
    assert actual == expected


@pytest.mark.parametrize("seed", range(120))
def test_fuzz_matches_oracle(tmp_path: Path, seed: int) -> None:
    rng = random.Random(seed)
    books, trades = _fuzz_day(rng)
    bucket_ms = rng.choice([60_000, 180_000, 600_000])
    session = rng.choice([(None, None), (32_400_000, 55_800_000)])
    _compare_day(tmp_path, books, trades, bucket_ms, session)


def test_no_touches_matches_oracle(tmp_path: Path) -> None:
    rng = random.Random(999)
    books, _ = _fuzz_day(rng)
    _compare_day(tmp_path, books, [], 60_000, (None, None))


def test_empty_books_matches_oracle(tmp_path: Path) -> None:
    _compare_day(tmp_path, [], [], 60_000, (None, None))


@pytest.mark.skipif(
    not os.environ.get("HOGA_ORACLE_REAL_DIR"),
    reason="set HOGA_ORACLE_REAL_DIR=<parquet/<date>/<code>/hogaplay dir> for real-data run",
)
def test_real_day_matches_oracle() -> None:
    d = Path(os.environ["HOGA_ORACLE_REAL_DIR"])
    con = duckdb.connect()
    expected = oracle_query_day_ask_bid_peak_dual(
        con, path=d / "snapshots.parquet", trades_path=d / "trades.parquet", bucket_ms=600_000,
    )
    actual = query_day_ask_bid_peak_dual(
        con, path=d / "snapshots.parquet", trades_path=d / "trades.parquet", bucket_ms=600_000,
    )
    assert actual == expected
