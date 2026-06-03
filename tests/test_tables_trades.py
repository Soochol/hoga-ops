from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pyarrow.parquet as pq
import pytest

from hoga.tables.trades import (
    PARQUET_SCHEMA,
    PARSERS,
    Trade,
    TradeValidationError,
    validate,
    write_parquet,
)

# Sample raw TSV rows (parts list, pre-split) for each event type the module handles.
_CONTINUOUS_TRADE = [
    "2",
    "1",
    "25",
    "2123",
    "90008726",
    "32408726",
    "274500",
    "-2.31",
    "+4",
    "789300",
    "216275",
    "274000",
    "274500",
    "274000",
    "-32765914",
    "2.35",
    "0.01",
    "500.00",
]
_AUCTION_TRADE = [
    "2",
    "1",
    "24",
    "2122",
    "90008618",
    "32408618",
    "274000",
    "-2.49",
    "788290",
    "789296",
    "216274",
    "274000",
    "274000",
    "274000",
    "-32765918",
    "2.35",
    "0.01",
    "500.00",
]
_PREMARKET = ["1", "3", "10", "11", "84000352", "31200352", "0", "0", "501", "0"]


def test_parsers_registered_for_event_types_1_and_3() -> None:
    assert set(PARSERS.keys()) == {1, 3}


def test_parse_continuous_trade_signed_positive() -> None:
    t = PARSERS[1](_CONTINUOUS_TRADE)
    assert isinstance(t, Trade)
    assert t.qty == 4
    assert t.side == 1
    assert t.cum_vol == 789300


def test_parse_auction_cross_trade_unsigned() -> None:
    t = PARSERS[1](_AUCTION_TRADE)
    assert t.qty == 788290
    assert t.side == 0


def test_parse_premarket_row_is_side_zero_trade() -> None:
    t = PARSERS[3](_PREMARKET)
    assert isinstance(t, Trade)
    assert t.qty == 501
    assert t.side == 0


def test_parquet_schema_has_expected_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in (
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
    ):
        assert col in names, f"missing column {col}"


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    trades = [
        PARSERS[3](_PREMARKET),
        PARSERS[1](_AUCTION_TRADE),
        PARSERS[1](_CONTINUOUS_TRADE),
    ]
    out = tmp_path / "trades.parquet"
    write_parquet(trades, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 3
    assert tbl.column("ts_ms").to_pylist() == sorted(tbl.column("ts_ms").to_pylist()), "ascending"


def test_validate_passes_for_monotonic_cum_vol() -> None:
    # Auction Cross (side=0, cum_vol=0) is excluded; only the continuous trade is checked.
    trades = [PARSERS[3](_PREMARKET), PARSERS[1](_AUCTION_TRADE), PARSERS[1](_CONTINUOUS_TRADE)]
    validate(trades)  # should not raise


def test_validate_raises_on_cum_vol_regression() -> None:
    # Build two continuous trades where the second has lower cum_vol than the first.
    base = PARSERS[1](_CONTINUOUS_TRADE)  # cum_vol=789300, ts_ms=90008726
    earlier = replace(base, ts_ms=90008000, seq=2122, cum_vol=1000)
    later = replace(base, ts_ms=90008500, seq=2123, cum_vol=500)  # cum_vol drops!
    with pytest.raises(TradeValidationError, match="cum_vol decreased"):
        validate([earlier, later])


def test_validate_lenient_skips_violations() -> None:
    base = PARSERS[1](_CONTINUOUS_TRADE)
    earlier = replace(base, ts_ms=90008000, seq=2122, cum_vol=1000)
    later = replace(base, ts_ms=90008500, seq=2123, cum_vol=500)
    # No exception raised in lenient mode
    validate([earlier, later], lenient=True)


def test_validate_tie_breaks_by_seq_on_identical_ts_ms() -> None:
    # Regression: real-data 005930/20260520 capture failed because the parser's
    # dedup-first-occurrence-wins inserted seq=356045 into trades_list BEFORE
    # seq=356044 (page 1000 read before page 997 due to lexical sort bug).
    # Both seqs shared ts_ms=12:35:49.069 (sub-ms collision), so the stable
    # ts_ms-only sort preserved the wrong order and cum_vol regressed.
    # Fix: validate sorts by (ts_ms, seq), so any input order produces the
    # canonical seq order for identical-ts_ms rows.
    base = PARSERS[1](_CONTINUOUS_TRADE)
    # Same ts_ms, different seqs. cum_vol is monotonic in seq order.
    row_later_seq = replace(base, ts_ms=90008000, seq=200, cum_vol=22301687)
    row_earlier_seq = replace(base, ts_ms=90008000, seq=199, cum_vol=22301662)
    # Input order is (later_seq, earlier_seq) — would fail without tie-break.
    validate([row_later_seq, row_earlier_seq])  # should not raise


def test_find_cum_vol_violations_returns_empty_for_clean_data() -> None:
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_001_000, seq=10, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=5, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
        Trade(ts_ms=90_002_000, seq=11, price=101, change_pct=1.0, qty=3,
              side=1, cum_vol=8, cum_trades=2, low_so_far=100, high_so_far=101,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
    ]
    assert find_cum_vol_violations(trades) == []


def test_find_cum_vol_violations_reports_each_regression() -> None:
    """Returns one entry per regression — not just first."""
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_001_000, seq=10, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=10, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
        Trade(ts_ms=90_002_000, seq=11, price=99, change_pct=-1.0, qty=2,
              side=-1, cum_vol=8, cum_trades=2, low_so_far=99, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
        Trade(ts_ms=90_003_000, seq=12, price=99, change_pct=-1.0, qty=2,
              side=-1, cum_vol=5, cum_trades=3, low_so_far=99, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
    ]
    violations = find_cum_vol_violations(trades)
    assert len(violations) == 2
    assert violations[0].prev_cum == 10 and violations[0].curr_cum == 8
    assert violations[0].ts_ms == 90_002_000
    assert violations[1].prev_cum == 8 and violations[1].curr_cum == 5


def test_find_cum_vol_violations_excludes_auction_cross_rows() -> None:
    """side=0 rows carry cum_vol=0 and must be excluded from the check."""
    from hoga.tables.trades import find_cum_vol_violations, Trade
    trades = [
        Trade(ts_ms=90_000_000, seq=1, price=100, change_pct=0.0, qty=10,
              side=0, cum_vol=0, cum_trades=0, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
        Trade(ts_ms=90_001_000, seq=2, price=100, change_pct=0.0, qty=5,
              side=1, cum_vol=15, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=0, unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0),
    ]
    assert find_cum_vol_violations(trades) == []


# ---------------------------------------------------------------------------
# query_fill_strength (ADR-0001): bucketed buy/sell aggregation, native time
# ---------------------------------------------------------------------------


def _trade(*, ts_ms: int, seq: int, qty: int, side: int) -> Trade:
    """Minimal continuous-trade Trade for fill-strength fixtures.

    qty is the positive magnitude; sign lives in ``side`` (+1 buy, -1 sell,
    0 auction cross). Forensic / cum fields are irrelevant to the aggregation.
    """
    return Trade(
        ts_ms=ts_ms, seq=seq, price=1000, change_pct=0.0, qty=qty, side=side,
        cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0,
        unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
    )


def test_query_fill_strength_buckets_on_linear_minute_boundary(tmp_path: Path) -> None:
    """Two trades straddling a minute boundary must land in distinct, ascending
    intra_ms buckets — the whole reason this uses hhmmssms_to_intra_ms_sql
    instead of naive ts_ms // bucket_ms (raw HHMMSSmmm is non-linear)."""
    import duckdb

    from hoga.tables.trades import query_fill_strength

    # 09:00:59.000 = HHMMSSmmm 90059000, 09:01:00.000 = HHMMSSmmm 90100000.
    # Linear ms-from-midnight: 09:00:59.000 -> 32_459_000; 09:01:00.000 -> 32_460_000.
    # With bucket_ms=60_000: bucket_a = (32_459_000 // 60_000) * 60_000 = 32_400_000
    #                        bucket_b = (32_460_000 // 60_000) * 60_000 = 32_460_000
    trades = [
        _trade(ts_ms=90_059_000, seq=1, qty=10, side=1),
        _trade(ts_ms=90_100_000, seq=2, qty=7, side=1),
    ]
    out = tmp_path / "trades.parquet"
    write_parquet(trades, out)
    con = duckdb.connect()
    rows = query_fill_strength(con, path=out, bucket_ms=60_000)
    assert [r.bucket_intra_ms for r in rows] == [32_400_000, 32_460_000]  # ascending, distinct
    assert [r.buy_qty for r in rows] == [10, 7]
    assert [r.sell_qty for r in rows] == [0, 0]


def test_query_fill_strength_splits_buy_and_sell(tmp_path: Path) -> None:
    """side=1 qty -> buy_qty, side=-1 qty -> sell_qty within the same bucket."""
    import duckdb

    from hoga.tables.trades import query_fill_strength

    trades = [
        _trade(ts_ms=90_000_100, seq=1, qty=10, side=1),
        _trade(ts_ms=90_000_200, seq=2, qty=4, side=-1),
        _trade(ts_ms=90_000_300, seq=3, qty=6, side=1),
    ]
    out = tmp_path / "trades.parquet"
    write_parquet(trades, out)
    con = duckdb.connect()
    rows = query_fill_strength(con, path=out, bucket_ms=60_000)
    assert len(rows) == 1
    assert rows[0].buy_qty == 16
    assert rows[0].sell_qty == 4


def test_query_fill_strength_excludes_auction_cross(tmp_path: Path) -> None:
    """side=0 (auction cross / premarket) rows contribute nothing (WHERE side != 0)."""
    import duckdb

    from hoga.tables.trades import query_fill_strength

    trades = [
        _trade(ts_ms=90_000_100, seq=1, qty=999, side=0),  # excluded
        _trade(ts_ms=90_000_200, seq=2, qty=5, side=1),
    ]
    out = tmp_path / "trades.parquet"
    write_parquet(trades, out)
    con = duckdb.connect()
    rows = query_fill_strength(con, path=out, bucket_ms=60_000)
    assert len(rows) == 1
    assert rows[0].buy_qty == 5
    assert rows[0].sell_qty == 0


def test_query_fill_strength_empty_parquet_returns_no_rows(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_fill_strength

    out = tmp_path / "trades.parquet"
    write_parquet([], out)
    con = duckdb.connect()
    assert query_fill_strength(con, path=out, bucket_ms=60_000) == []
