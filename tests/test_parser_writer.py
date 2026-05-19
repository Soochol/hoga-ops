from __future__ import annotations

from pathlib import Path

import pyarrow.parquet as pq

from hoga.parser.events import BrokerRow, Candle, Orderbook, Trade
from hoga.parser.writer import (
    write_brokers_parquet,
    write_candles_parquet,
    write_snapshots_parquet,
    write_trades_parquet,
)


def test_trades_roundtrip(tmp_path: Path) -> None:
    trades = [
        Trade(
            ts_ms=90000000,
            seq=1,
            price=25800,
            change_pct=0.39,
            qty=100,
            side=1,
            cum_vol=100,
            cum_trades=1,
            low_so_far=25800,
            high_so_far=25800,
            net_pressure=100,
            unknown_14=25800,
            unknown_16=0.0,
            unknown_17=0.0,
            unknown_18=0.0,
        ),
        Trade(
            ts_ms=90001000,
            seq=2,
            price=25750,
            change_pct=0.20,
            qty=50,
            side=-1,
            cum_vol=150,
            cum_trades=2,
            low_so_far=25750,
            high_so_far=25800,
            net_pressure=50,
            unknown_14=25750,
            unknown_16=0.0,
            unknown_17=0.0,
            unknown_18=0.0,
        ),
    ]
    out = tmp_path / "trades.parquet"
    write_trades_parquet(trades, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2  # noqa: PLR2004
    cols = tbl.column_names
    for c in ("ts_ms", "seq", "price", "qty", "side", "cum_vol"):
        assert c in cols
    assert tbl.column("side").to_pylist() == [1, -1]
    assert tbl.column("ts_ms").to_pylist() == [90000000, 90001000]


def test_snapshots_roundtrip(tmp_path: Path) -> None:
    ob = Orderbook(
        ts_ms=90000000,
        seq=1,
        ask_p=tuple([25800] + [0] * 9),
        ask_q=tuple([100] + [0] * 9),
        ask_d=tuple([0] * 10),
        bid_p=tuple([25750] + [0] * 9),
        bid_q=tuple([200] + [0] * 9),
        bid_d=tuple([0] * 10),
        tot_ask=100,
        tot_ask_d=0,
        tot_bid=200,
        tot_bid_d=0,
    )
    out = tmp_path / "snapshots.parquet"
    write_snapshots_parquet([ob], out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 1
    assert tbl.column("ask_p1").to_pylist() == [25800]
    assert tbl.column("bid_p1").to_pylist() == [25750]
    assert tbl.column("ask_q1").to_pylist() == [100]
    assert tbl.column("tot_bid").to_pylist() == [200]
    for prefix in ("ask_p", "ask_q", "ask_d", "bid_p", "bid_q", "bid_d"):
        for i in range(1, 11):
            assert f"{prefix}{i}" in tbl.column_names


def test_brokers_roundtrip(tmp_path: Path) -> None:
    rows = [
        BrokerRow(
            ts_ms=90000000,
            seq=1,
            side="sell",
            rank=1,
            broker="미래에셋",
            qty_today=1000,
            qty_delta=1000,
        ),
        BrokerRow(
            ts_ms=90000000,
            seq=1,
            side="buy",
            rank=1,
            broker="키움",
            qty_today=900,
            qty_delta=900,
        ),
    ]
    out = tmp_path / "brokers.parquet"
    write_brokers_parquet(rows, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2  # noqa: PLR2004
    assert set(tbl.column("side").to_pylist()) == {"sell", "buy"}


def test_candles_roundtrip(tmp_path: Path) -> None:
    candles = [
        Candle(
            ts_ms=30600000,
            open_=281000,
            close_=281000,
            high=281000,
            low=281000,
            vol_a=119,
            vol_b=0,
        ),
        Candle(
            ts_ms=30660000,
            open_=281000,
            close_=281000,
            high=281000,
            low=281000,
            vol_a=10,
            vol_b=2,
        ),
    ]
    out = tmp_path / "candles.parquet"
    write_candles_parquet(candles, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 2  # noqa: PLR2004
    assert tbl.column("ts_ms").to_pylist() == [30600000, 30660000]
