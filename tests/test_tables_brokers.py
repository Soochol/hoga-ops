from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.brokers import (
    PARQUET_SCHEMA,
    PARSERS,
    BrokerRow,
    write_parquet,
)


def _broker_parts(ts_ms: int = 90019919, seq: int = 912) -> list[str]:
    return [
        "2",
        "4",
        "0",
        str(seq),
        str(ts_ms),
        "32419919",
        "미래에셋",
        "NH투자증권",
        "키움증권",
        "한국투자증권",
        "신한투자증권",
        "1798",
        "1291",
        "1210",
        "1164",
        "804",
        "1798",
        "1291",
        "1210",
        "1164",
        "804",
        "아이엠증권",
        "유비에스증권",
        "NH투자증권",
        "JP모간서울",
        "키움증권",
        "3450",
        "1236",
        "968",
        "602",
        "549",
        "3450",
        "1236",
        "968",
        "602",
        "549",
        "0",
        "0",
        "1838",
        "1838",
        "1838",
        "1838",
    ]


def test_parser_registered_for_event_type_4() -> None:
    assert set(PARSERS.keys()) == {4}


def test_parse_fans_one_row_into_ten() -> None:
    rows = PARSERS[4](_broker_parts())
    assert isinstance(rows, list)
    assert all(isinstance(r, BrokerRow) for r in rows)
    assert len(rows) == 10
    sells = [r for r in rows if r.side == "sell"]
    buys = [r for r in rows if r.side == "buy"]
    assert len(sells) == 5
    assert len(buys) == 5
    assert sells[0].broker == "미래에셋"
    assert sells[0].rank == 1
    assert sells[0].qty_today == 1798
    assert buys[0].broker == "아이엠증권"


def test_parquet_schema_columns() -> None:
    names = PARQUET_SCHEMA.names
    for col in ("ts_ms", "seq", "side", "rank", "broker", "qty_today", "qty_delta"):
        assert col in names


def test_write_parquet_roundtrip(tmp_path: Path) -> None:
    rows = PARSERS[4](_broker_parts())
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    tbl = pq.read_table(out)
    assert tbl.num_rows == 10
    assert set(tbl.column("side").to_pylist()) == {"sell", "buy"}


from hoga.api.models import BrokerSeriesEntry
from hoga.tables.brokers import query_day_series


def _broker_parts_named(
    ts_ms: int,
    seq: int,
    *,
    sell_names: list[str],
    sell_today: list[int],
    buy_names: list[str],
    buy_today: list[int],
) -> list[str]:
    """Variant of _broker_parts that lets a test seed specific broker names
    and qty_today values for each of the 5 sell / 5 buy slots."""
    assert len(sell_names) == 5 and len(sell_today) == 5
    assert len(buy_names) == 5 and len(buy_today) == 5
    deltas = ["0"] * 5
    trailing = ["0", "0", "1838", "1838", "1838", "1838"]
    return (
        ["2", "4", "0", str(seq), str(ts_ms), "32419919"]
        + sell_names
        + [str(q) for q in sell_today]
        + deltas
        + buy_names
        + [str(q) for q in buy_today]
        + deltas
        + trailing
    )


def test_query_day_series_orders_by_abs_final_net_desc(tmp_path: Path) -> None:
    """Top entry is the broker with the largest |final_net| at the last snapshot."""
    # Snapshot 1 (early in the day) and snapshot 2 (later — wins for final_net).
    early = PARSERS[4](
        _broker_parts_named(
            ts_ms=90019919,
            seq=912,
            sell_names=["미래에셋", "키움증권", "한국투자", "신한투자", "NH투자"],
            sell_today=[100, 100, 100, 100, 100],
            buy_names=["JP모간", "모건스탠", "신한투자", "한국투자", "KB증권"],
            buy_today=[100, 100, 100, 100, 100],
        )
    )
    late = PARSERS[4](
        _broker_parts_named(
            ts_ms=130000000,
            seq=913,
            sell_names=["KB증권", "미래에셋", "키움증권", "한국투자", "NH투자"],
            sell_today=[86579, 85356, 74253, 7452, 100],
            buy_names=["JP모간", "모건스탠", "신한투자", "한국투자", "KB증권"],
            buy_today=[79523, 77616, 59427, 0, 0],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(early + late, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    # Top entry is KB증권 (|−86579 + 0| = 86579 dominates).
    assert isinstance(entries[0], BrokerSeriesEntry)
    assert entries[0].broker == "KB증권"
    assert entries[0].final_net == -86579
    assert entries[0].dominant_side == "sell"
    # JP모간 is the heaviest pure-buyer (+79523).
    jp = next(e for e in entries if e.broker == "JP모간")
    assert jp.final_net == 79523
    assert jp.dominant_side == "buy"


def test_query_day_series_preserves_observed_points_only_no_forward_fill(
    tmp_path: Path,
) -> None:
    """A broker present at t1 but absent at t2 has one point, not two."""
    early = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["A", "B", "C", "D", "E"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["JP모간", "X", "Y", "Z", "W"],
            buy_today=[50, 10, 10, 10, 10],
        )
    )
    # JP모간 drops out of top-5 at the later snapshot — no row for it.
    late = PARSERS[4](
        _broker_parts_named(
            ts_ms=130000000,
            seq=2,
            sell_names=["A", "B", "C", "D", "E"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["P", "Q", "R", "S", "T"],
            buy_today=[100, 100, 100, 100, 100],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(early + late, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    jp = next(e for e in entries if e.broker == "JP모간")
    assert len(jp.points) == 1
    assert jp.points[0].ts_ms == 90000000
    assert jp.points[0].net == 50


def test_query_day_series_signs_dual_side_broker(tmp_path: Path) -> None:
    """A broker appearing on both sides at the same snapshot has net = buy − sell."""
    row = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["KB증권", "B", "C", "D", "E"],
            sell_today=[300, 10, 10, 10, 10],
            buy_names=["KB증권", "Q", "R", "S", "T"],
            buy_today=[100, 10, 10, 10, 10],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(row, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    kb = next(e for e in entries if e.broker == "KB증권")
    assert len(kb.points) == 1
    assert kb.points[0].net == 100 - 300  # buy − sell = −200
    assert kb.final_net == -200
    assert kb.dominant_side == "sell"


def test_query_day_series_truncates_to_top_10(tmp_path: Path) -> None:
    """If more than 10 distinct brokers exist, only the top 10 by |final_net| ship."""
    # 5 sell brokers + 5 buy brokers per snapshot = 10 distinct. Use two snapshots
    # with fully disjoint buy lists to push the distinct count to 15.
    s1 = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[1, 2, 3, 4, 5],
            buy_names=["B1", "B2", "B3", "B4", "B5"],
            buy_today=[1000, 900, 800, 700, 600],
        )
    )
    s2 = PARSERS[4](
        _broker_parts_named(
            ts_ms=100000000,
            seq=2,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[1, 2, 3, 4, 5],
            buy_names=["B6", "B7", "B8", "B9", "B10"],  # 5 new brokers
            buy_today=[10, 9, 8, 7, 6],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(s1 + s2, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    assert len(entries) == 10  # B6..B10 (small) cut off
    # First five are the big buyers.
    assert entries[0].broker == "B1"
    assert entries[0].final_net == 1000


def test_query_day_series_returns_empty_list_on_empty_parquet(tmp_path: Path) -> None:
    """No broker rows — empty list, not crash."""
    out = tmp_path / "brokers.parquet"
    # Write a zero-row parquet with the right schema.
    write_parquet([], out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    assert entries == []
