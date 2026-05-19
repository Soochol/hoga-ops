"""Convert event dataclasses into pyarrow Tables and write Parquet."""

from __future__ import annotations

from collections.abc import Iterable
from pathlib import Path

import pyarrow as pa
import pyarrow.parquet as pq

from hoga.parser.events import BrokerRow, Candle, Orderbook, Trade


def write_trades_parquet(trades: Iterable[Trade], path: Path) -> None:
    rows = sorted(trades, key=lambda t: t.ts_ms)
    cols = {
        "ts_ms": pa.array([t.ts_ms for t in rows], type=pa.int64()),
        "seq": pa.array([t.seq for t in rows], type=pa.int32()),
        "price": pa.array([t.price for t in rows], type=pa.int32()),
        "change_pct": pa.array([t.change_pct for t in rows], type=pa.float32()),
        "qty": pa.array([t.qty for t in rows], type=pa.int32()),
        "side": pa.array([t.side for t in rows], type=pa.int8()),
        "cum_vol": pa.array([t.cum_vol for t in rows], type=pa.int64()),
        "cum_trades": pa.array([t.cum_trades for t in rows], type=pa.int32()),
        "low_so_far": pa.array([t.low_so_far for t in rows], type=pa.int32()),
        "high_so_far": pa.array([t.high_so_far for t in rows], type=pa.int32()),
        "net_pressure": pa.array([t.net_pressure for t in rows], type=pa.int64()),
        "unknown_14": pa.array([t.unknown_14 for t in rows], type=pa.int32()),
        "unknown_16": pa.array([t.unknown_16 for t in rows], type=pa.float32()),
        "unknown_17": pa.array([t.unknown_17 for t in rows], type=pa.float32()),
        "unknown_18": pa.array([t.unknown_18 for t in rows], type=pa.float32()),
    }
    pq.write_table(pa.table(cols), path)


def write_snapshots_parquet(snapshots: Iterable[Orderbook], path: Path) -> None:
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
        for i in range(10):
            cols[f"{prefix}{i + 1}"] = pa.array(
                [getattr(o, attr)[i] for o in rows], type=pa.int32()
            )
    cols["tot_ask"] = pa.array([o.tot_ask for o in rows], type=pa.int32())
    cols["tot_ask_d"] = pa.array([o.tot_ask_d for o in rows], type=pa.int32())
    cols["tot_bid"] = pa.array([o.tot_bid for o in rows], type=pa.int32())
    cols["tot_bid_d"] = pa.array([o.tot_bid_d for o in rows], type=pa.int32())
    pq.write_table(pa.table(cols), path)


def write_brokers_parquet(brokers: Iterable[BrokerRow], path: Path) -> None:
    rows = sorted(brokers, key=lambda r: (r.ts_ms, r.side, r.rank))
    cols = {
        "ts_ms": pa.array([r.ts_ms for r in rows], type=pa.int64()),
        "seq": pa.array([r.seq for r in rows], type=pa.int32()),
        "side": pa.array([r.side for r in rows], type=pa.string()),
        "rank": pa.array([r.rank for r in rows], type=pa.int8()),
        "broker": pa.array([r.broker for r in rows], type=pa.string()),
        "qty_today": pa.array([r.qty_today for r in rows], type=pa.int32()),
        "qty_delta": pa.array([r.qty_delta for r in rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols), path)


def write_candles_parquet(candles: Iterable[Candle], path: Path) -> None:
    rows = sorted(candles, key=lambda c: c.ts_ms)
    cols = {
        "ts_ms": pa.array([c.ts_ms for c in rows], type=pa.int64()),
        "open": pa.array([c.open_ for c in rows], type=pa.int32()),
        "close": pa.array([c.close_ for c in rows], type=pa.int32()),
        "high": pa.array([c.high for c in rows], type=pa.int32()),
        "low": pa.array([c.low for c in rows], type=pa.int32()),
        "vol_a": pa.array([c.vol_a for c in rows], type=pa.int32()),
        "vol_b": pa.array([c.vol_b for c in rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols), path)
