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


# ---------------------------------------------------------------------------
# query_trade_volume_poc: date-scope most-traded +/-0.5%/+/-1% price band
# ---------------------------------------------------------------------------


def test_query_trade_volume_poc_defaults_to_tick_adjusted_half_pct_band(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_trade_volume_poc

    p = tmp_path / "trades.parquet"
    write_parquet([
        _price_trade(ts_ms=90_100_000, seq=1, price=71_500, qty=20, side=1),
        _price_trade(ts_ms=90_200_000, seq=2, price=72_300, qty=50, side=-1),
        _price_trade(ts_ms=90_300_000, seq=3, price=73_100, qty=30, side=1),
        _price_trade(ts_ms=90_400_000, seq=4, price=76_000, qty=99, side=1),
    ], p)

    row = query_trade_volume_poc(
        duckdb.connect(),
        path=p,
        session_open_ms=90_000_000,
        session_close_ms=152_000_000,
    )

    assert row is not None
    assert row.center_price == 76_000
    assert row.low_price == 75_600
    assert row.high_price == 76_400
    assert row.qty == 99
    assert row.intra_ms == 32_640_000


def test_query_trade_volume_poc_can_select_tick_adjusted_one_pct_band(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_trade_volume_poc

    p = tmp_path / "trades.parquet"
    write_parquet([
        _price_trade(ts_ms=90_100_000, seq=1, price=71_500, qty=20, side=1),
        _price_trade(ts_ms=90_200_000, seq=2, price=72_300, qty=50, side=-1),
        _price_trade(ts_ms=90_300_000, seq=3, price=73_100, qty=30, side=1),
        _price_trade(ts_ms=90_400_000, seq=4, price=76_000, qty=99, side=1),
    ], p)

    row = query_trade_volume_poc(
        duckdb.connect(),
        path=p,
        session_open_ms=90_000_000,
        session_close_ms=152_000_000,
        band_pct=0.01,
    )

    assert row is not None
    assert row.center_price == 72_300
    assert row.low_price == 71_500
    assert row.high_price == 73_100
    assert row.qty == 100
    assert row.intra_ms == 32_520_000


def test_query_trade_volume_poc_excludes_auction_side_and_outside_session(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_trade_volume_poc

    p = tmp_path / "trades.parquet"
    write_parquet([
        _price_trade(ts_ms=85_900_000, seq=1, price=70_000, qty=1_000, side=1),
        _price_trade(ts_ms=90_100_000, seq=2, price=72_000, qty=10, side=1),
        _price_trade(ts_ms=151_900_000, seq=3, price=72_100, qty=20, side=-1),
        _price_trade(ts_ms=152_000_000, seq=4, price=70_000, qty=1_000, side=1),
        _price_trade(ts_ms=100_000_000, seq=5, price=70_000, qty=1_000, side=0),
    ], p)

    row = query_trade_volume_poc(
        duckdb.connect(),
        path=p,
        session_open_ms=90_000_000,
        session_close_ms=152_000_000,
    )

    assert row is not None
    assert row.center_price == 72_000
    assert row.low_price == 71_600
    assert row.high_price == 72_400
    assert row.qty == 30


def test_query_trade_volume_poc_returns_none_for_no_regular_trades(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_trade_volume_poc

    p = tmp_path / "trades.parquet"
    write_parquet([
        _price_trade(ts_ms=90_100_000, seq=1, price=70_000, qty=1_000, side=0),
    ], p)

    assert query_trade_volume_poc(
        duckdb.connect(),
        path=p,
        session_open_ms=90_000_000,
        session_close_ms=152_000_000,
    ) is None


# ---------------------------------------------------------------------------
# query_volume_profile_range (ADR-0001): multi-file price/qty binning, sparse rows
# ---------------------------------------------------------------------------


def _price_trade(*, ts_ms: int, seq: int, price: int, qty: int, side: int = 0) -> Trade:
    """Minimal Trade for volume-profile fixtures (price + qty are what matter)."""
    return Trade(
        ts_ms=ts_ms, seq=seq, price=price, change_pct=0.0, qty=qty, side=side,
        cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0,
        unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
    )


def test_query_volume_profile_range_bins_across_files(tmp_path: Path) -> None:
    """Two trades.parquet files are unioned (multi-file read_parquet); price
    range spans both; qty is summed per bin. No side filter (auction crosses
    count, per spec §4.1)."""
    import duckdb

    from hoga.tables.trades import query_volume_profile_range

    p1 = tmp_path / "a.parquet"
    p2 = tmp_path / "b.parquet"
    # File 1: prices 100 (qty 10), 100 (qty 5). File 2: price 200 (qty 30).
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=100, qty=10, side=1),
        _price_trade(ts_ms=90_000_200, seq=2, price=100, qty=5, side=-1),
    ], p1)
    write_parquet([
        _price_trade(ts_ms=90_000_300, seq=3, price=200, qty=30, side=0),
    ], p2)
    con = duckdb.connect()
    res = query_volume_profile_range(con, paths=[str(p1), str(p2)], vp_bins=2)
    assert res is not None
    assert res.price_min == 100
    assert res.price_max == 200
    # range 100..200 over 2 bins -> bin_width 50. price 100 -> bin 0 (qty 15);
    # price 200 -> FLOOR((200-100)/50)=2. bin_idx 2 == vp_bins is the top-edge
    # raw row; the table returns raw sparse rows (GROUP BY), so it emits idx 2.
    # The bundle is responsible for folding idx==vp_bins into vp_bins-1 (top bin).
    bins = dict(res.bins)
    assert bins.get(0) == 15  # 10 + 5
    assert bins.get(2) == 30  # raw top-edge row: FLOOR((200-100)/50)=2
    assert res.bin_width == 50


def test_query_volume_profile_range_zero_width_guard(tmp_path: Path) -> None:
    """Single-price day (price_min == price_max) -> bin_width floored at 1
    (no ZeroDivision); all qty lands in bin 0."""
    import duckdb

    from hoga.tables.trades import query_volume_profile_range

    p = tmp_path / "t.parquet"
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=500, qty=7),
        _price_trade(ts_ms=90_000_200, seq=2, price=500, qty=3),
    ], p)
    con = duckdb.connect()
    res = query_volume_profile_range(con, paths=[str(p)], vp_bins=24)
    assert res is not None
    assert res.price_min == 500
    assert res.price_max == 500
    assert res.bin_width == 1  # floored
    assert dict(res.bins).get(0) == 10


def test_query_volume_profile_range_no_trades_returns_none(tmp_path: Path) -> None:
    """Empty parquet -> MIN/MAX is NULL -> method signals 'no trades' via None,
    bundle maps that to an empty (bin_count=0) profile."""
    import duckdb

    from hoga.tables.trades import query_volume_profile_range

    p = tmp_path / "empty.parquet"
    write_parquet([], p)
    con = duckdb.connect()
    assert query_volume_profile_range(con, paths=[str(p)], vp_bins=24) is None


def test_query_volume_profile_range_exposes_raw_float_bin_width(tmp_path: Path) -> None:
    """bin_width is the RAW float (not truncated). For a fractional width the
    caller computes price_low from this float; truncating in the method would
    shift the grid (e.g. bin 6: int(6*4.1666)=25 vs 6*4=24). Locks the
    no-behavior-change relocation of build_volume_profile_range."""
    import duckdb

    from hoga.tables.trades import query_volume_profile_range

    p = tmp_path / "t.parquet"
    # range 0..100 over 24 bins -> bin_width_raw = 100/24 = 4.16666...
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=0, qty=1),
        _price_trade(ts_ms=90_000_200, seq=2, price=100, qty=1),
    ], p)
    con = duckdb.connect()
    res = query_volume_profile_range(con, paths=[str(p)], vp_bins=24)
    assert res is not None
    assert abs(res.bin_width - 100 / 24) < 1e-9   # raw float, NOT int(4)
    # Downstream price_low for bin 6 must use the float: int(0 + 6 * 4.1666) = 25.
    assert int(res.price_min + 6 * res.bin_width) == 25


# ---------------------------------------------------------------------------
# query_volume_profile (ADR-0001): single-file binning within a caller-supplied
# price range (cross-table: bundle derives lo/hi from candles)
# ---------------------------------------------------------------------------


def test_query_volume_profile_bins_within_supplied_range(tmp_path: Path) -> None:
    """Bins trades' price/qty within [price_lo, price_hi] (no side filter —
    auction crosses count, per spec §4.1). Range is supplied by the caller."""
    import duckdb

    from hoga.tables.trades import query_volume_profile

    p = tmp_path / "t.parquet"
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=100, qty=10, side=1),
        _price_trade(ts_ms=90_000_200, seq=2, price=100, qty=5, side=-1),
        _price_trade(ts_ms=90_000_300, seq=3, price=150, qty=7, side=0),
    ], p)
    con = duckdb.connect()
    res = query_volume_profile(con, path=p, price_lo=100, price_hi=200, bins=2)
    assert res is not None
    assert res.price_min == 100
    assert res.price_max == 200
    assert res.bin_width == 50.0  # (200-100)/2
    bins = dict(res.bins)
    assert bins.get(0) == 15  # prices 100 -> bin 0 (10+5)
    assert bins.get(1) == 7   # price 150 -> FLOOR((150-100)/50)=1


def test_query_volume_profile_exposes_raw_float_bin_width(tmp_path: Path) -> None:
    """bin_width is the RAW float (mirrors range): a fractional width must not
    be truncated in the method, else price_low shifts downstream. No zero-width
    guard here (slice 4 has none) — only fractional/normal ranges are tested."""
    import duckdb

    from hoga.tables.trades import query_volume_profile

    p = tmp_path / "t.parquet"
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=0, qty=1),
        _price_trade(ts_ms=90_000_200, seq=2, price=100, qty=1),
    ], p)
    con = duckdb.connect()
    # range 0..100 over 24 bins -> bin_width_raw = 4.16666...
    res = query_volume_profile(con, path=p, price_lo=0, price_hi=100, bins=24)
    assert res is not None
    assert abs(res.bin_width - 100 / 24) < 1e-9
    assert int(res.price_min + 6 * res.bin_width) == 25


def test_query_volume_profile_zero_width_guard(tmp_path: Path) -> None:
    """Single-price day (price_lo == price_hi, e.g. limit-lock 점상한가):
    bin_width is floored at 1 (no DuckDB ConversionException / HTTP 500).
    All qty must land in bin 0 — a degenerate single-bin profile."""
    import duckdb

    from hoga.tables.trades import query_volume_profile

    p = tmp_path / "t.parquet"
    write_parquet([
        _price_trade(ts_ms=90_000_100, seq=1, price=500, qty=7),
        _price_trade(ts_ms=90_000_200, seq=2, price=500, qty=3),
    ], p)
    con = duckdb.connect()
    res = query_volume_profile(con, path=p, price_lo=500, price_hi=500, bins=24)
    assert res is not None
    assert res.price_min == 500
    assert res.price_max == 500
    assert res.bin_width == 1  # floored at 1 (mirrors query_volume_profile_range)
    bins = dict(res.bins)
    assert bins.get(0) == 10  # all qty in bin 0


# ---------------------------------------------------------------------------
# query_continuous_trade_volume_distribution: session-bounded, side-filtered
# binning for 연속체결 매물대 분포 (Continuous Trade Volume Distribution)
# ---------------------------------------------------------------------------


def test_continuous_trade_volume_distribution_filters_side_and_session(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_continuous_trade_volume_distribution

    path = tmp_path / "trades.parquet"
    write_parquet([
        Trade(ts_ms=85_959_000, seq=1, price=100, change_pct=0, qty=999, side=1,
              cum_vol=999, cum_trades=1, low_so_far=100, high_so_far=100,
              net_pressure=999, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90_000_000, seq=2, price=100, change_pct=0, qty=10, side=1,
              cum_vol=1009, cum_trades=2, low_so_far=100, high_so_far=100,
              net_pressure=1009, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90_100_000, seq=3, price=110, change_pct=0, qty=20, side=-1,
              cum_vol=1029, cum_trades=3, low_so_far=100, high_so_far=110,
              net_pressure=989, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=90_200_000, seq=4, price=120, change_pct=0, qty=30, side=0,
              cum_vol=0, cum_trades=0, low_so_far=0, high_so_far=0,
              net_pressure=0, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
        Trade(ts_ms=153_000_000, seq=5, price=120, change_pct=0, qty=777, side=1,
              cum_vol=1806, cum_trades=4, low_so_far=100, high_so_far=120,
              net_pressure=1766, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], path)

    con = duckdb.connect()
    got = query_continuous_trade_volume_distribution(
        con,
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert got.price_min == 100
    assert got.price_max == 120
    assert got.bins == [(0, 10), (1, 20)]


def test_continuous_trade_volume_distribution_folds_high_price_into_last_bin(tmp_path: Path) -> None:
    import duckdb

    from hoga.tables.trades import query_continuous_trade_volume_distribution

    path = tmp_path / "trades.parquet"
    write_parquet([
        Trade(ts_ms=93_000_000, seq=1, price=120, change_pct=0, qty=33, side=1,
              cum_vol=33, cum_trades=1, low_so_far=120, high_so_far=120,
              net_pressure=33, unknown_14=0, unknown_16=0, unknown_17=0, unknown_18=0),
    ], path)

    con = duckdb.connect()
    got = query_continuous_trade_volume_distribution(
        con,
        path=path,
        price_lo=100,
        price_hi=120,
        bins=2,
        session_open_ms=90_000_000,
        session_close_ms=153_000_000,
    )

    assert got.bins == [(2, 33)]


# ---------------------------------------------------------------------------
# dedup_overlap_resends — drop hogaplay page re-send duplicates (keep-LAST)
# ---------------------------------------------------------------------------


def _ct(*, seq: int, cum_vol: int, side: int = -1, qty: int = 1, ts_ms: int = 100_656_387) -> Trade:
    """Continuous trade with a controllable cum_vol / seq for dedup fixtures."""
    from hoga.tables.trades import Trade
    return Trade(
        ts_ms=ts_ms, seq=seq, price=24_600, change_pct=0.0, qty=qty, side=side,
        cum_vol=cum_vol, cum_trades=0, low_so_far=0, high_so_far=0, net_pressure=0,
        unknown_14=0, unknown_16=0.0, unknown_17=0.0, unknown_18=0.0,
    )


def test_dedup_overlap_resends_keeps_last_copy_and_restores_monotonicity() -> None:
    """Models the 003490/20260506 page re-send: a continuous-trade burst is sent
    twice with FRESH seqs, so the later copy restarts at a lower cum_vol and the
    stream regresses. Keep-LAST (max seq per cum_vol) drops the earlier copies;
    sorting the survivors by (ts_ms, seq) is then monotonic."""
    from hoga.tables.trades import dedup_overlap_resends, find_cum_vol_violations
    # First copy seq 10-12 (cum 100,110,120), then a re-send seq 13-15 of the
    # SAME cum_vols (the overlap) plus genuine continuation seq 16 (cum 130).
    trades = [
        _ct(seq=10, cum_vol=100), _ct(seq=11, cum_vol=110), _ct(seq=12, cum_vol=120),
        _ct(seq=13, cum_vol=100), _ct(seq=14, cum_vol=110), _ct(seq=15, cum_vol=120),
        _ct(seq=16, cum_vol=130),
    ]
    # Pre-dedup the set has duplicate cum_vols (the double-count source).
    assert sum(1 for t in trades if t.cum_vol == 100) == 2
    out = dedup_overlap_resends(trades)
    # One survivor per cum_vol, and it's the LAST (max seq) copy.
    assert [t.seq for t in out] == [13, 14, 15, 16]
    assert [t.cum_vol for t in out] == [100, 110, 120, 130]
    # Sorted by (ts_ms, seq) the survivors are monotonic — regression gone.
    ordered = sorted(out, key=lambda t: (t.ts_ms, t.seq))
    assert find_cum_vol_violations(ordered) == []


def test_dedup_overlap_resends_is_noop_for_clean_data() -> None:
    from hoga.tables.trades import dedup_overlap_resends
    trades = [_ct(seq=1, cum_vol=10), _ct(seq=2, cum_vol=20), _ct(seq=3, cum_vol=30)]
    assert dedup_overlap_resends(trades) == trades


def test_dedup_overlap_resends_never_drops_auction_cross_rows() -> None:
    """side=0 rows all carry cum_vol=0 — they legitimately share it and must
    survive (dropping them would lose Auction Cross volume)."""
    from hoga.tables.trades import dedup_overlap_resends
    trades = [
        _ct(seq=1, cum_vol=0, side=0, qty=100),
        _ct(seq=2, cum_vol=0, side=0, qty=200),
        _ct(seq=3, cum_vol=50, side=1),
    ]
    out = dedup_overlap_resends(trades)
    assert [t.seq for t in out] == [1, 2, 3]


def test_dedup_overlap_resends_excludes_zero_qty_from_cum_vol_key() -> None:
    """Defensive: a qty=0 continuous row does not increment cum_vol, so cum_vol
    is no longer unique among such rows — they are kept as-is, never deduped."""
    from hoga.tables.trades import dedup_overlap_resends
    trades = [
        _ct(seq=1, cum_vol=100, qty=0),
        _ct(seq=2, cum_vol=100, qty=0),
        _ct(seq=3, cum_vol=100, qty=5),
    ]
    out = dedup_overlap_resends(trades)
    # Both qty=0 rows survive; the qty>0 row is the sole keep-LAST for cum 100.
    assert [t.seq for t in out] == [1, 2, 3]
