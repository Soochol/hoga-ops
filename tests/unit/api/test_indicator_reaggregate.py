"""1-minute → coarser-timeframe re-aggregation for the /api/range indicator cache.

The cache stores quote_ratio / fill_strength at 1m per (code, date, source) and
re-aggregates on read. The contract that makes the cache safe is EQUIVALENCE with
a direct ``query_bucketed_ratio(bucket_ms=N)`` / ``query_fill_strength(bucket_ms=N)``
— so these tests run the real table queries against a real parquet and assert that
``reaggregate(query(1m), N) == query(N)`` for every minute timeframe, including a
closing-auction day (ADR-0029/0062), which is where the "last continuous rep"
rule is non-trivial.
"""
from __future__ import annotations

from pathlib import Path

import duckdb
import polars as pl

from hoga.api.indicator_reaggregate import reaggregate_fill, reaggregate_ratio
from hoga.api.timeenc import hhmmssms_to_unix_ms, unix_ms_to_hhmmssms
from hoga.tables.snapshots import QuoteRatioRow, query_bucketed_ratio
from hoga.tables.trades import FillStrengthRow, query_fill_strength

DATE = "20260529"
DAY_START = hhmmssms_to_unix_ms(DATE, 0)
CLOSE_FULL = 153000000  # 15:30:00.000 HHMMSSmmm

# All /api/range minute timeframes (ms). 1m is the cache granularity.
MINUTE_BUCKETS = [60_000, 180_000, 300_000, 600_000, 900_000, 1_800_000]


def _unix(h: int, m: int, s: int = 0) -> int:
    return DAY_START + (h * 3600 + m * 60 + s) * 1000


# ── Pure-logic tests (no parquet) ────────────────────────────────────────────


def _qr(intra: int, bid: int, ask: int) -> QuoteRatioRow:
    return QuoteRatioRow(bucket_intra_ms=intra, bid_total=bid, ask_total=ask)


def _fs(intra: int, buy: int, sell: int) -> FillStrengthRow:
    return FillStrengthRow(bucket_intra_ms=intra, buy_qty=buy, sell_qty=sell)


def test_reaggregate_ratio_takes_last_in_window() -> None:
    # 1m rows at minutes 0,1,2 → one 3m bucket; the LAST (minute 2) wins.
    rows = [_qr(0, 10, 20), _qr(60_000, 11, 21), _qr(120_000, 12, 22)]
    out = reaggregate_ratio(rows, 180_000)
    assert out == [_qr(0, 12, 22)]


def test_reaggregate_ratio_skips_trailing_auction_zeros() -> None:
    # minute 2 is a fully-auction (0,0) sentinel → the 3m rep is the last
    # NON-(0,0) minute (minute 1), exactly as the direct Nm query would pick the
    # last continuous representative and exclude the auction book.
    rows = [_qr(0, 10, 20), _qr(60_000, 11, 21), _qr(120_000, 0, 0)]
    out = reaggregate_ratio(rows, 180_000)
    assert out == [_qr(0, 11, 21)]


def test_reaggregate_ratio_all_auction_window_stays_zero() -> None:
    # every minute fully-auction → the bucket is emitted at (0,0), not dropped.
    rows = [_qr(0, 0, 0), _qr(60_000, 0, 0), _qr(120_000, 0, 0)]
    out = reaggregate_ratio(rows, 180_000)
    assert out == [_qr(0, 0, 0)]


def test_reaggregate_ratio_one_sided_book_is_not_a_zero_sentinel() -> None:
    # (0, >0) is a real one-sided continuous book, NOT the auction sentinel —
    # it must be eligible as the representative.
    rows = [_qr(0, 5, 5), _qr(60_000, 0, 9), _qr(120_000, 0, 0)]
    out = reaggregate_ratio(rows, 180_000)
    assert out == [_qr(0, 0, 9)]


def test_reaggregate_fill_sums_window() -> None:
    rows = [_fs(0, 10, 1), _fs(60_000, 20, 2), _fs(120_000, 30, 3)]
    out = reaggregate_fill(rows, 180_000)
    assert out == [_fs(0, 60, 6)]


def test_reaggregate_identity_at_one_minute() -> None:
    rows = [_qr(0, 10, 20), _qr(60_000, 11, 21)]
    assert reaggregate_ratio(rows, 60_000) == rows
    frows = [_fs(0, 10, 1), _fs(60_000, 20, 2)]
    assert reaggregate_fill(frows, 60_000) == frows


# ── Equivalence vs the real table queries (the cache's correctness contract) ──


def _write_snaps(path: Path, snaps: list[tuple[int, int, int, bool]]) -> None:
    """snaps: (unix_ms, bid_total, ask_total, is_continuous). Mirrors the fixture
    shape of test_quote_ratio_auction_decontam (deep level set iff continuous)."""
    rows = []
    for unix_ms, bid_total, ask_total, is_cont in snaps:
        row: dict = {"ts_ms": unix_ms_to_hhmmssms(DATE, unix_ms), "phase": "regular"}
        for i in range(1, 11):
            row[f"bid_p{i}"] = 100
            row[f"ask_p{i}"] = 101
            row[f"bid_q{i}"] = 0
            row[f"ask_q{i}"] = 0
        if is_cont:
            row["bid_q1"] = bid_total - 1
            row["bid_q4"] = 1
            row["ask_q1"] = ask_total - 1
            row["ask_q4"] = 1
        else:
            row["bid_q1"] = bid_total
            row["ask_q1"] = ask_total
        row["total_bid_qty"] = bid_total
        row["total_ask_qty"] = ask_total
        rows.append(row)
    path.parent.mkdir(parents=True, exist_ok=True)
    pl.DataFrame(rows).write_parquet(path)


def _auction_day_snaps() -> list[tuple[int, int, int, bool]]:
    """A realistic continuous session (09:00–15:20, two snapshots per minute so
    'last in bucket' is exercised) followed by the closing auction (15:20–15:30,
    3-level books). Values vary per snapshot so coarser buckets genuinely differ."""
    snaps: list[tuple[int, int, int, bool]] = []
    minute = 0
    h, m = 9, 0
    while (h, m) < (15, 20):
        bid = 11 + (minute * 7) % 50
        ask = 21 + (minute * 13) % 50
        snaps.append((_unix(h, m, 10), bid, ask, True))
        snaps.append((_unix(h, m, 40), bid + 1, ask + 2, True))  # later → wins its minute
        minute += 1
        m += 1
        if m == 60:
            m = 0
            h += 1
    # Closing auction 15:20–15:29 (3-level, excluded as the representative).
    for mm in range(20, 30):
        snaps.append((_unix(15, mm, 30), 900 + mm, 800 + mm, False))
    return snaps


def test_ratio_reaggregation_equals_direct_query_auction_day(tmp_path: Path) -> None:
    path = tmp_path / "snapshots.parquet"
    _write_snaps(path, _auction_day_snaps())
    con = duckdb.connect()
    base_1m = query_bucketed_ratio(con, path=path, bucket_ms=60_000, session_close_ms=CLOSE_FULL)
    for bucket_ms in MINUTE_BUCKETS:
        direct = query_bucketed_ratio(
            con, path=path, bucket_ms=bucket_ms, session_close_ms=CLOSE_FULL
        )
        reagg = reaggregate_ratio(base_1m, bucket_ms)
        assert reagg == direct, f"ratio mismatch at bucket_ms={bucket_ms}"


def test_fill_reaggregation_equals_direct_query(tmp_path: Path) -> None:
    # Trades every 20s, alternating aggressor side, qty varied. side=0 rows
    # (excluded by the query) interleaved to prove the cache inherits the filter.
    rows = []
    minute = 0
    h, m = 9, 0
    while (h, m) < (15, 30):
        for s, side, qty in ((5, 1, 10 + minute % 7), (25, -1, 5 + minute % 3), (45, 0, 999)):
            ts = unix_ms_to_hhmmssms(DATE, _unix(h, m, s))
            rows.append({"ts_ms": ts, "side": side, "qty": qty})
        minute += 1
        m += 1
        if m == 60:
            m = 0
            h += 1
    path = tmp_path / "trades.parquet"
    pl.DataFrame(rows).write_parquet(path)
    con = duckdb.connect()
    base_1m = query_fill_strength(con, path=path, bucket_ms=60_000)
    for bucket_ms in MINUTE_BUCKETS:
        direct = query_fill_strength(con, path=path, bucket_ms=bucket_ms)
        reagg = reaggregate_fill(base_1m, bucket_ms)
        assert reagg == direct, f"fill mismatch at bucket_ms={bucket_ms}"
