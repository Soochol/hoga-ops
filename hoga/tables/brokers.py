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


def series_entries_from_rows(
    rows: Iterable[tuple[str, int, int]],
) -> list["BrokerSeriesEntry"]:
    """`(broker_raw, ts_ms, signed_net)` 행 → BrokerSeriesEntry top-10.

    canonical 정규화 후 같은 (firm, ts_ms)를 합산하고(별칭 2개가 한 점으로),
    브로커별 시계열로 묶어 |final_net| desc, final_net desc로 최대 10개.

    ts_ms 인코딩 무관(parquet HHMMSSmmm·버퍼 unix-ms 양쪽 동작) — 호출부가
    단위를 일관되게 넣는다. parquet·버퍼 두 소스가 이 한 집계를 공유한다(#9).

    `points`는 관측 스냅샷만 — top-5 탈락 구간 forward-fill 없음(ADR-0023, 프론트
    가 dashed로 렌더).
    """
    from hoga.api.models import BrokerSeriesEntry, BrokerSeriesPoint  # local: avoid cycle
    from hoga.broker_names import canonical

    collapsed: dict[tuple[str, int], int] = {}
    for raw_broker, ts_ms, net in rows:
        key = (canonical(raw_broker), int(ts_ms))
        collapsed[key] = collapsed.get(key, 0) + int(net)

    by_broker: dict[str, list[BrokerSeriesPoint]] = {}
    for (broker, ts_ms), net in sorted(collapsed.items()):
        by_broker.setdefault(broker, []).append(
            BrokerSeriesPoint(ts_ms=ts_ms, net=net)
        )

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


def broker_rows_from_snapshots(
    snapshots: Iterable[dict],
) -> list[tuple[str, int, int]]:
    """라이브 버퍼 broker 스냅샷 → `(broker_raw, t_ms, signed_net)` 행.

    한 스냅샷 내 buy=+qty / sell=−qty. qty는 KIS 회원사 누적 거래량으로 parquet
    `qty_today`와 동일 의미(promote.py가 qty를 qty_today에 직매핑)라, 각 점이 그
    시각까지의 누적net 그 자체 → query_day_series_today의 오프셋 없는 concat이
    연속(tests/test_broker_series_seam.py 동치 핀). canonical 합산은
    series_entries_from_rows가 수행.
    """
    rows: list[tuple[str, int, int]] = []
    for snap in snapshots:
        t_ms = int(snap.get("t_ms") or 0)
        for e in snap.get("buy_top") or []:
            name = e.get("name")
            if isinstance(name, str) and name:
                rows.append((name, t_ms, int(e.get("qty") or 0)))
        for e in snap.get("sell_top") or []:
            name = e.get("name")
            if isinstance(name, str) and name:
                rows.append((name, t_ms, -int(e.get("qty") or 0)))
    return rows


def query_day_series(
    con: duckdb.DuckDBPyConnection, *, path: Path
) -> list["BrokerSeriesEntry"]:
    """Per-broker signed-net trajectories for the whole parquet file.

    Aggregates qty_today * sign(side) per (broker, ts_ms), then groups via
    `series_entries_from_rows` (top-10, canonical-collapsed). Returns ts_ms in
    the parquet's HHMMSSmmm encoding — the route converts to Unix-ms.
    """
    rows = con.execute(
        """
        SELECT
            broker,
            ts_ms,
            SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
        FROM read_parquet(?)
        GROUP BY broker, ts_ms
        """,
        [str(path)],
    ).fetchall()
    return series_entries_from_rows((b, int(t), int(n)) for b, t, n in rows)


def query_day_series_today(
    con: duckdb.DuckDBPyConnection,
    path: Path,
    *,
    date: str,
    buffer_snapshots: Iterable[dict],
) -> list["BrokerSeriesEntry"]:
    """today 봉합: parquet(승격분, ts≤seam) + 라이브 버퍼 꼬리(ts>seam)를
    **unix-ms 공간에서** 합쳐 당일 전체 시리즈 반환(#9, 접근 B).

    parquet 행은 HHMMSSmmm → hhmmssms_to_unix_ms로 변환 후 합치므로 반환
    entries의 points.ts_ms는 **이미 unix-ms** — 라우트는 today 경로에서 재변환
    금지(이중변환 시 epoch 오프셋만큼 전 점 이동). seam=max(parquet unix ts),
    동률 버퍼 점은 제외(parquet 권위). 파일 부재(첫 승격 전)면 read_parquet가
    raise하므로 DuckDB 읽기를 생략하고 버퍼만(seam=None) — advisor critical.
    """
    from hoga.api.timeenc import hhmmssms_to_unix_ms  # local: low-level, avoid top cycle

    parquet_rows: list[tuple[str, int, int]] = []
    seam_ms: int | None = None
    if path.exists():
        raw = con.execute(
            """
            SELECT
                broker,
                ts_ms,
                SUM(CASE WHEN side = 'buy' THEN qty_today ELSE -qty_today END) AS net
            FROM read_parquet(?)
            GROUP BY broker, ts_ms
            """,
            [str(path)],
        ).fetchall()
        for b, enc_ts, net in raw:
            unix_ts = hhmmssms_to_unix_ms(date, int(enc_ts))
            parquet_rows.append((b, unix_ts, int(net)))
            seam_ms = unix_ts if seam_ms is None else max(seam_ms, unix_ts)

    tail_rows = [
        (b, t, n)
        for (b, t, n) in broker_rows_from_snapshots(buffer_snapshots)
        if seam_ms is None or t > seam_ms
    ]
    return series_entries_from_rows(parquet_rows + tail_rows)
