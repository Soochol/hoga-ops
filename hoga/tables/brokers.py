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


@dataclass(frozen=True)
class BrokerDetailRow:
    broker: str
    net: int
    dominant_side: BrokerSide


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
    from hoga.api._atomic_write import atomic_write_parquet_table
    atomic_write_parquet_table(path, pa.table(cols, schema=PARQUET_SCHEMA))


def query_day_series(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> list["BrokerSeriesEntry"]:
    """Per-broker signed-net trajectories for the whole parquet file.

    Aggregates qty_today * sign(side) per (broker, ts_ms) so a broker on
    both sides at the same snapshot collapses to one signed value, then
    groups in Python into one BrokerSeriesEntry per broker. Returns at most
    10 entries sorted by abs(final_net) desc, final_net desc.

    Broker names are canonicalized (see ``hoga.broker_names``) before the
    Python-side group so hogaplay and KIS aliases for the same KRX member
    firm collapse into a single entry.

    `points` contains only observed snapshots — no synthetic forward-fill
    for gaps when the broker fell out of both top-5 lists (the frontend
    renders such gaps with a dashed line; see ADR-0023).
    """
    from hoga.api.models import BrokerSeriesEntry  # local: avoid cycle

    by_broker = _query_canonical_series_points(con, path=path)
    if not by_broker:
        return []

    entries = [
        BrokerSeriesEntry(
            broker=broker,
            final_net=points[-1].net,
            dominant_side="buy" if points[-1].net >= 0 else "sell",
            points=points,
        )
        for broker, points in by_broker.items()
    ]
    entries.sort(key=lambda e: (-abs(e.final_net), -e.final_net))
    return entries[:10]


def _query_canonical_series_points(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
) -> dict[str, list["BrokerSeriesPoint"]]:
    """Return live broker-series points after canonical alias collapse."""
    from hoga.api.models import BrokerSeriesPoint  # local: avoid cycle
    from hoga.broker_names import canonical

    rows = con.execute(
        """
        SELECT
            broker,
            ts_ms,
            SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
        FROM read_parquet(?)
        GROUP BY broker, ts_ms
        ORDER BY broker, ts_ms
        """,
        [str(path)],
    ).fetchall()

    # Canonicalize broker names then re-collapse: two raw aliases for the
    # same firm at the same ts_ms must sum into one signed point.
    collapsed: dict[tuple[str, int], int] = {}
    for raw_broker, ts_ms, net in rows:
        key = (canonical(raw_broker), int(ts_ms))
        collapsed[key] = collapsed.get(key, 0) + int(net)

    by_broker: dict[str, list[BrokerSeriesPoint]] = {}
    for (broker, ts_ms), net in sorted(collapsed.items()):
        by_broker.setdefault(broker, []).append(
            BrokerSeriesPoint(ts_ms=ts_ms, net=net)
        )
    return by_broker


def _final_broker_order(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    limit: int,
) -> list[str]:
    """Return top broker names ordered by the same final net as live series."""
    by_broker = _query_canonical_series_points(con, path=path)

    ordered = sorted(
        by_broker.items(),
        key=lambda item: (-abs(item[1][-1].net), -item[1][-1].net),
    )
    return [broker for broker, _points in ordered[:limit]]


def query_cumulative_details_at(
    con: duckdb.DuckDBPyConnection,
    *,
    path: Path,
    t_values: list[int],
    limit: int = 10,
) -> dict[int, list[BrokerDetailRow]]:
    """Top broker cumulative net at each native cursor timestamp.

    The result mirrors Cursor Sidebar ordering: select and order brokers by
    final full-file net, then project each ordered broker's net at the cursor.
    """
    from bisect import bisect_right

    from hoga.broker_names import canonical

    if not t_values:
        return {}
    uniq = sorted({int(t) for t in t_values})
    final_order = _final_broker_order(con, path=path, limit=limit)
    if not final_order:
        return {t: [] for t in uniq}
    final_broker_set = set(final_order)

    rows = con.execute(
        """
        SELECT
            p.broker,
            p.ts_ms,
            p.seq,
            SUM(CASE WHEN p.side = 'buy' THEN p.qty_today ELSE -p.qty_today END) AS net
        FROM read_parquet(?) AS p
        GROUP BY p.broker, p.ts_ms, p.seq
        ORDER BY p.broker, p.ts_ms, p.seq
        """,
        [str(path)],
    ).fetchall()

    collapsed: dict[tuple[str, int, int], int] = {}
    for raw_broker, ts_ms, seq, net in rows:
        key = (canonical(raw_broker), int(ts_ms), int(seq))
        collapsed[key] = collapsed.get(key, 0) + int(net)

    by_broker: dict[str, list[tuple[int, int, int]]] = {}
    for (broker, ts_ms, seq), net in sorted(collapsed.items()):
        if broker not in final_broker_set:
            continue
        by_broker.setdefault(broker, []).append((ts_ms, seq, net))

    indexed: dict[str, tuple[list[tuple[int, int]], list[int]]] = {}
    for broker in final_order:
        points = by_broker.get(broker, [])
        indexed[broker] = (
            [(ts_ms, seq) for ts_ms, seq, _net in points],
            [net for _ts_ms, _seq, net in points],
        )

    grouped: dict[int, list[BrokerDetailRow]] = {t: [] for t in uniq}
    max_seq = 2**31 - 1
    for cursor_ts in uniq:
        details: list[BrokerDetailRow] = []
        for broker in final_order:
            keys, nets = indexed[broker]
            idx = bisect_right(keys, (cursor_ts, max_seq)) - 1
            if idx < 0:
                continue
            net = nets[idx]
            details.append(
                BrokerDetailRow(
                    broker=broker,
                    net=net,
                    dominant_side="buy" if net >= 0 else "sell",
                )
            )
        grouped[cursor_ts] = details
    return grouped
