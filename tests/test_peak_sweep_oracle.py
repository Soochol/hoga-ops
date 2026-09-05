"""Oracle equivalence for the minute-scoped peak-wall classifier (ADR-0156).

The ORACLE here is a deliberately **naive** implementation: for each wall event
it scans every trade tick and asks "is this tick in the same 1-minute window and
does it dominate the wall price?". O(N·M) and obviously correct by inspection —
the production path (`_classify_wall_frame`) instead groups touches into a
per-minute extreme and left-joins, and must agree on:

  * seeded fuzz books/trades (many shapes: touches at the same (ts,seq) as a
    book, collapsed books, session bounds, empty touches), and
  * optionally real captured days (env ``HOGA_ORACLE_REAL_DIR`` — manual run).

If prod and oracle ever diverge, the failing seed pins the repro.

History: this file used to freeze the pre-vectorization Fenwick sweep (ADR-0085)
because the "touched by any LATER tick" relation (ADR-0084) needed one. ADR-0156
closed the relation inside a minute, so a naive scan is now both feasible and a
**stronger** oracle — it shares no structure with the implementation.
"""
from __future__ import annotations

import os
import random
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
    hhmmssms_to_intra_ms_sql,
    query_day_ask_bid_peak_dual,
    write_parquet,
)
from hoga.tables.trades import Trade, write_parquet as write_trades

# ─────────────────────────────────────────────────────────────────────────────
# ORACLE — naive minute-scoped classifier. Do not "optimise": sharing structure
# with the implementation is exactly what would make this oracle worthless.
# ─────────────────────────────────────────────────────────────────────────────

_TOUCH_WINDOW_MS = 60_000


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
    intra_ms: int
    price: int


def _event_rank_key(e: _WallEvent) -> tuple[int, int, int, int]:
    return (-e.qty, e.intra_ms, e.seq, e.price)


def _classify_wall_stream(
    events: list[_WallEvent],
    touches: list[_Touch],
    *,
    side: str,
) -> tuple[list[tuple[_WallEvent, bool]], dict[int, _WallEvent]]:
    """(이벤트, touched) 목록과 **터치된 이벤트의 가격당 rank-1** 사전.

    touched 판정은 전수 스캔이다: 같은 1분 창의 체결 중 가격으로 지배하는 것이
    하나라도 있는가. 순서는 보지 않는다(ADR-0156).
    """
    is_ask = side == "ask"

    def touched_of(e: _WallEvent) -> bool:
        window = e.intra_ms // _TOUCH_WINDOW_MS
        for t in touches:
            if t.intra_ms // _TOUCH_WINDOW_MS != window:
                continue
            if (t.price >= e.price) if is_ask else (t.price <= e.price):
                return True
        return False

    classified = [(e, touched_of(e)) for e in sorted(events, key=lambda e: (e.ts_ms, e.seq))]

    distinct_best: dict[int, _WallEvent] = {}
    for e, touched in classified:
        if not touched:
            continue
        cur = distinct_best.get(e.price)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            distinct_best[e.price] = e

    return classified, distinct_best


def _read_peak_wall_streams(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    trades_path: Path,
    bucket_ms: int,
    where: str,
    intra: str,
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
        SELECT {intra} AS intra_ms, price
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
        _Touch(intra_ms=int(intra_ms), price=int(price))
        for intra_ms, price in touch_rows
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


def _record_sequence(classified: list[tuple[_WallEvent, bool]]) -> tuple[AskPeakCandidateRow, ...]:
    """기록 갱신 시퀀스의 **독립 구현**(순수 파이썬 루프) — 프로덕션 polars cum_max 와
    fuzz 로 교차 검증된다. 규칙 동일: (intra_ms, seq, -qty) 정렬 · strict > · cap 128."""
    touched = sorted((e for e, t in classified if t), key=lambda e: (e.intra_ms, e.seq, -e.qty))
    out: list[AskPeakCandidateRow] = []
    best = -1
    for e in touched:
        if e.qty > best:
            out.append(AskPeakCandidateRow(price=e.price, qty=e.qty, intra_ms=e.intra_ms))
            best = e.qty
        if len(out) >= 128:
            break
    return tuple(out)


def _bar_max_sequence(classified: list[tuple[_WallEvent, bool]]) -> tuple[AskPeakCandidateRow, ...]:
    """봉별 최대의 **독립 구현**(순수 파이썬 dict) — 프로덕션 polars
    `unique(subset=["bucket_id"])` 와 fuzz 로 교차 검증된다.

    규칙 동일: 터치된 것만 · bucket_id 당 랭킹 1위(`_event_rank_key`) · **시간순** 반환.
    `_record_sequence`(누적 prefix maxima)와 축이 다르다는 것이 이 함수의 요점이라,
    구조를 공유하지 않게 일부러 따로 적는다.
    """
    best: dict[int, _WallEvent] = {}
    for e, touched in classified:
        if not touched:
            continue
        cur = best.get(e.bucket_id)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            best[e.bucket_id] = e
    ordered = sorted(best.values(), key=lambda e: e.intra_ms)
    return tuple(
        AskPeakCandidateRow(price=e.price, qty=e.qty, intra_ms=e.intra_ms) for e in ordered
    )


def _peak_scalar(rows: list[_WallEvent]) -> tuple[int, int, int] | None:
    if not rows:
        return None
    e = min(rows, key=_event_rank_key)
    return (e.price, e.qty, e.intra_ms)


def _unreached_rows(
    classified: list[tuple[_WallEvent, bool]],
    touches: list[_Touch],
    *,
    side: str,
) -> list[_WallEvent]:
    """미도달의 소박한 판: 당일 체결 극값이 가격으로 지배하지 못한 이벤트 전부.

    체결이 0건이면 전부 미도달이다. 프로덕션(`_unreached_wall_frame`)과 구조를
    공유하지 않도록 이벤트별 전수 비교로 둔다.
    """
    rows = [e for e, _t in classified]
    if not touches:
        return rows
    if side == "ask":
        extreme = max(t.price for t in touches)
        return [e for e in rows if e.price > extreme]
    extreme = min(t.price for t in touches)
    return [e for e in rows if e.price < extreme]


def _price_distinct(rows: list[_WallEvent]) -> list[_WallEvent]:
    best: dict[int, _WallEvent] = {}
    for e in rows:
        cur = best.get(e.price)
        if cur is None or _event_rank_key(e) < _event_rank_key(cur):
            best[e.price] = e
    return list(best.values())


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
    where = _book_indicator_eligible_sql(
        intra, session_open_ms=session_open_ms, session_close_ms=session_close_ms,
    )

    streams, touches = _read_peak_wall_streams(
        con, path=path, trades_path=trades_path, bucket_ms=bucket_ms,
        where=where, intra=intra,
    )

    def _side_row(side: str) -> dict | None:
        rep_classified, rep_distinct = _classify_wall_stream(streams[f"{side}_rep"], touches, side=side)
        cont_classified, cont_distinct = _classify_wall_stream(streams[f"{side}_cont"], touches, side=side)

        all_close = _peak_scalar([e for e, _t in rep_classified])
        all_max = _peak_scalar([e for e, _t in cont_classified])
        if all_close is None or all_max is None:
            return None

        rep_traded = list(rep_distinct.values())
        cont_traded = list(cont_distinct.values())
        unreached = _unreached_rows(cont_classified, touches, side=side)

        return {
            "all_close": all_close,
            "all_max": all_max,
            "traded_close": _peak_scalar(rep_traded),
            "traded_max": _peak_scalar(cont_traded),
            "traded_peaks": _peak_candidates(rep_traded, 3),
            "traded_max_peaks": _peak_candidates(cont_traded, 3),
            "traded_record_peaks": _record_sequence(rep_classified),
            "traded_record_max_peaks": _record_sequence(cont_classified),
            "traded_bar_peaks": _bar_max_sequence(rep_classified),
            "traded_bar_max_peaks": _bar_max_sequence(cont_classified),
            "all_peaks": _peak_candidates(_peak_bucket_dedup(rep_classified), 3),
            "all_max_peaks": _peak_candidates(_peak_bucket_dedup(cont_classified), 3),
            "unreached": _peak_scalar(unreached),
            "unreached_peaks": _peak_candidates(_price_distinct(unreached), 3),
        }

    ask = _side_row("ask")
    bid = _side_row("bid")

    ask_row: AskPeakDualRow | None = None
    if ask is not None:
        tc, tm, ur = ask["traded_close"], ask["traded_max"], ask["unreached"]
        ask_row = AskPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=ask["traded_peaks"], traded_max_peaks=ask["traded_max_peaks"],
            traded_record_peaks=ask["traded_record_peaks"],
            traded_record_max_peaks=ask["traded_record_max_peaks"],
            traded_bar_peaks=ask["traded_bar_peaks"],
            traded_bar_max_peaks=ask["traded_bar_max_peaks"],
            all_price=ask["all_close"][0], all_qty=ask["all_close"][1], all_intra_ms=ask["all_close"][2],
            all_max_price=ask["all_max"][0], all_max_qty=ask["all_max"][1], all_max_intra_ms=ask["all_max"][2],
            all_peaks=ask["all_peaks"], all_max_peaks=ask["all_max_peaks"],
            unreached_price=ur[0] if ur else None, unreached_qty=ur[1] if ur else None,
            unreached_intra_ms=ur[2] if ur else None,
            unreached_peaks=ask["unreached_peaks"],
        )

    bid_row: BidPeakDualRow | None = None
    if bid is not None:
        tc, tm, ur = bid["traded_close"], bid["traded_max"], bid["unreached"]
        bid_row = BidPeakDualRow(
            price=tc[0] if tc else None, qty=tc[1] if tc else None, intra_ms=tc[2] if tc else None,
            max_price=tm[0] if tm else None, max_qty=tm[1] if tm else None, max_intra_ms=tm[2] if tm else None,
            traded_peaks=bid["traded_peaks"], traded_max_peaks=bid["traded_max_peaks"],
            traded_record_peaks=bid["traded_record_peaks"],
            traded_record_max_peaks=bid["traded_record_max_peaks"],
            traded_bar_peaks=bid["traded_bar_peaks"],
            traded_bar_max_peaks=bid["traded_bar_max_peaks"],
            all_price=bid["all_close"][0], all_qty=bid["all_close"][1], all_intra_ms=bid["all_close"][2],
            all_max_price=bid["all_max"][0], all_max_qty=bid["all_max"][1], all_max_intra_ms=bid["all_max"][2],
            all_peaks=bid["all_peaks"], all_max_peaks=bid["all_max_peaks"],
            unreached_price=ur[0] if ur else None, unreached_qty=ur[1] if ur else None,
            unreached_intra_ms=ur[2] if ur else None,
            unreached_peaks=bid["unreached_peaks"],
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
