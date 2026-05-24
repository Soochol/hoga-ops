"""Brokers table — top-5 buy + top-5 sell broker rankings (상위 거래원).

One TSV row (event type 4) produces 10 BrokerRow entities in long format.
"""

from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Literal

if TYPE_CHECKING:
    from hoga.api.models import BrokerSeriesEntry, BrokerSeriesPoint

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


# BrokersAt: per-query container.
#
# Brokers is the only table whose query returns "N rows from a single
# point in time" — ts_ms is metadata on the result set, not on each row.
# Other tables either return one row (ApiOrderbookSnapshot) or rows each
# carrying their own ts_ms (ApiTrade, ApiCandle), so no container is needed.
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


def query_day_series(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> list["BrokerSeriesEntry"]:
    """Per-broker signed-net trajectories for the whole parquet file.

    Aggregates qty_today * sign(side) per (broker, ts_ms) so a broker on
    both sides at the same snapshot collapses to one signed value, then
    groups in Python into one BrokerSeriesEntry per broker. Returns at most
    10 entries sorted by abs(final_net) desc, final_net desc.

    `points` contains only observed snapshots — no synthetic forward-fill
    for gaps when the broker fell out of both top-5 lists (the frontend
    renders such gaps with a dashed line; see ADR-0023).
    """
    from hoga.api.models import BrokerSeriesEntry, BrokerSeriesPoint  # local: avoid cycle

    rows = con.execute(
        """
        WITH per_snapshot AS (
            SELECT
                broker,
                ts_ms,
                SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
            FROM read_parquet(?)
            GROUP BY broker, ts_ms
        )
        SELECT
            broker,
            ts_ms,
            net,
            LAST_VALUE(net) OVER (
                PARTITION BY broker
                ORDER BY ts_ms
                ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
            ) AS final_net
        FROM per_snapshot
        ORDER BY broker, ts_ms
        """,
        [str(path)],
    ).fetchall()

    if not rows:
        return []

    # Group rows by broker (rows are already broker-major then ts-ascending).
    by_broker: dict[str, tuple[int, list[BrokerSeriesPoint]]] = {}
    for broker, ts_ms, net, final_net in rows:
        if broker not in by_broker:
            by_broker[broker] = (int(final_net), [])
        by_broker[broker][1].append(BrokerSeriesPoint(ts_ms=int(ts_ms), net=int(net)))

    entries = [
        BrokerSeriesEntry(
            broker=broker,
            final_net=final_net,
            dominant_side="buy" if final_net >= 0 else "sell",
            points=points,
        )
        for broker, (final_net, points) in by_broker.items()
    ]
    entries.sort(key=lambda e: (-abs(e.final_net), -e.final_net))
    return entries[:10]
