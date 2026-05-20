"""Brokers table — top-5 buy + top-5 sell broker rankings (상위 거래원).

One TSV row (event type 4) produces 10 BrokerRow entities in long format.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import duckdb
import pyarrow as pa
import pyarrow.parquet as pq
from pydantic import BaseModel

BrokerSide = Literal["buy", "sell"]
TOP_N = 5


# === In-memory entity ===


@dataclass(frozen=True)
class BrokerRow:
    """One broker's slot at one snapshot. ts_ms + seq + side + rank is unique."""

    ts_ms: int
    seq: int
    side: BrokerSide
    rank: int  # 1..5
    broker: str
    qty_today: int
    qty_delta: int


# === TSV parser (one row -> 10 entities) ===


def _parse_broker(parts: list[str]) -> list[BrokerRow]:
    ts_ms = int(parts[4])
    seq = int(parts[3])
    base = 6
    sell_names = parts[base : base + TOP_N]
    sell_today = parts[base + TOP_N : base + 2 * TOP_N]
    sell_delta = parts[base + 2 * TOP_N : base + 3 * TOP_N]
    buy_names = parts[base + 3 * TOP_N : base + 4 * TOP_N]
    buy_today = parts[base + 4 * TOP_N : base + 5 * TOP_N]
    buy_delta = parts[base + 5 * TOP_N : base + 6 * TOP_N]
    rows: list[BrokerRow] = []
    for i, (name, today, delta) in enumerate(
        zip(sell_names, sell_today, sell_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms,
                seq=seq,
                side="sell",
                rank=i,
                broker=name,
                qty_today=int(today),
                qty_delta=int(delta),
            )
        )
    for i, (name, today, delta) in enumerate(
        zip(buy_names, buy_today, buy_delta, strict=True), start=1
    ):
        rows.append(
            BrokerRow(
                ts_ms=ts_ms,
                seq=seq,
                side="buy",
                rank=i,
                broker=name,
                qty_today=int(today),
                qty_delta=int(delta),
            )
        )
    return rows


EXPECTED_FIELD_COUNTS: dict[int, int] = {4: 42}
PARSERS: dict[int, Callable[[list[str]], list[BrokerRow]]] = {4: _parse_broker}


# === Wire schema ===


PARQUET_SCHEMA: pa.Schema = pa.schema(
    [
        pa.field("ts_ms", pa.int64()),
        pa.field("seq", pa.int32()),
        pa.field("side", pa.string()),
        pa.field("rank", pa.int8()),
        pa.field("broker", pa.string()),
        pa.field("qty_today", pa.int32()),
        pa.field("qty_delta", pa.int32()),
    ]
)


# === Persist ===


def write_parquet(rows: Iterable[BrokerRow], path: Path) -> None:
    sorted_rows = sorted(rows, key=lambda r: (r.ts_ms, r.side, r.rank))
    cols = {
        "ts_ms": pa.array([r.ts_ms for r in sorted_rows], type=pa.int64()),
        "seq": pa.array([r.seq for r in sorted_rows], type=pa.int32()),
        "side": pa.array([r.side for r in sorted_rows], type=pa.string()),
        "rank": pa.array([r.rank for r in sorted_rows], type=pa.int8()),
        "broker": pa.array([r.broker for r in sorted_rows], type=pa.string()),
        "qty_today": pa.array([r.qty_today for r in sorted_rows], type=pa.int32()),
        "qty_delta": pa.array([r.qty_delta for r in sorted_rows], type=pa.int32()),
    }
    pq.write_table(pa.table(cols, schema=PARQUET_SCHEMA), path)


# === API representation ===


class ApiBrokerEntry(BaseModel):
    side: str  # "buy" | "sell"
    rank: int
    broker: str
    qty_today: int
    qty_delta: int


class BrokersAt(BaseModel):
    """Result of `query_at`: ts_ms of the snapshot + all 10 broker entries (or empty)."""

    ts_ms: int | None
    entries: list[ApiBrokerEntry]


# === Query (returns BrokersAt — Pydantic, consistent with other tables) ===


def query_at(con: duckdb.DuckDBPyConnection, *, path: Path, t_ms: int) -> BrokersAt:
    """Return the latest broker snapshot at ts_ms <= t_ms.

    If no broker snapshot exists at or before ``t_ms``, returns
    ``BrokersAt(ts_ms=None, entries=[])``. Otherwise returns a BrokersAt with
    ``ts_ms`` set to the snapshot's timestamp and ``entries`` holding all 10
    rows (5 sell + 5 buy) as ApiBrokerEntry objects.
    """
    latest = con.execute(
        "SELECT max(ts_ms) FROM read_parquet(?) WHERE ts_ms <= ?",
        [str(path), t_ms],
    ).fetchone()
    if latest is None or latest[0] is None:
        return BrokersAt(ts_ms=None, entries=[])
    ts_ms_value = int(latest[0])
    rows = con.execute(
        "SELECT side, rank, broker, qty_today, qty_delta FROM read_parquet(?) "
        "WHERE ts_ms = ? ORDER BY side, rank",
        [str(path), ts_ms_value],
    ).fetchall()
    entries = [
        ApiBrokerEntry(side=r[0], rank=r[1], broker=r[2], qty_today=r[3], qty_delta=r[4])
        for r in rows
    ]
    return BrokersAt(ts_ms=ts_ms_value, entries=entries)
