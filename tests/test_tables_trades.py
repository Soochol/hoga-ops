from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import duckdb
import pyarrow.parquet as pq
import pytest

from hoga.tables.trades import (
    PARQUET_SCHEMA,
    PARSERS,
    ApiTrade,
    Trade,
    TradeValidationError,
    query_range,
    query_up_to,
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


def test_query_up_to_returns_api_models_descending(tmp_path: Path) -> None:
    out = tmp_path / "trades.parquet"
    write_parquet([PARSERS[1](_AUCTION_TRADE), PARSERS[1](_CONTINUOUS_TRADE)], out)
    con = duckdb.connect()
    rows = query_up_to(con, path=out, t_ms=90009000, limit=10)
    assert len(rows) == 2
    assert all(isinstance(r, ApiTrade) for r in rows)
    assert rows[0].ts_ms >= rows[1].ts_ms  # descending
    # ApiTrade has no forensic fields (unknown_14, _16, _17, _18 absent).
    assert not hasattr(rows[0], "unknown_14")


def test_query_range_returns_api_models(tmp_path: Path) -> None:
    out = tmp_path / "trades.parquet"
    write_parquet([PARSERS[3](_PREMARKET), PARSERS[1](_AUCTION_TRADE)], out)
    con = duckdb.connect()
    rows = query_range(con, path=out, from_ms=90008000, to_ms=90009000, limit=10)
    assert len(rows) == 1
    assert isinstance(rows[0], ApiTrade)
    assert rows[0].ts_ms == 90008618


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
