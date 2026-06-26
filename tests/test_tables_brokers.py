from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.brokers import (
    PARQUET_SCHEMA,
    PARSERS,
    BrokerRow,
    query_late_entry_events,
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


def test_query_day_series_returns_all_recorded_brokers(tmp_path: Path) -> None:
    rows: list[BrokerRow] = []
    for i in range(3):
        rows.extend(
            PARSERS[4](
                _broker_parts_named(
                    ts_ms=90000000 + i * 100000,
                    seq=i + 1,
                    sell_names=[f"S{i}-{j}" for j in range(5)],
                    sell_today=[100 + j for j in range(5)],
                    buy_names=[f"B{i}-{j}" for j in range(5)],
                    buy_today=[200 + j for j in range(5)],
                )
            )
        )
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    con = duckdb.connect()

    entries = query_day_series(con, path=out)

    assert len(entries) == 30
    assert [e.final_net for e in entries] == sorted(
        [e.final_net for e in entries],
        reverse=True,
    )


def test_query_late_entry_events_are_side_specific_and_once(
    tmp_path: Path,
) -> None:
    before = PARSERS[4](
        _broker_parts_named(
            ts_ms=92900000,
            seq=1,
            sell_names=["S1", "S2", "S3", "S4", "S5"],
            sell_today=[10, 10, 10, 10, 10],
            buy_names=["Dual", "B2", "B3", "B4", "B5"],
            buy_today=[50, 10, 10, 10, 10],
        )
    )
    at_threshold = PARSERS[4](
        _broker_parts_named(
            ts_ms=93000000,
            seq=2,
            sell_names=["Dual", "NewSell", "S3", "S4", "S5"],
            sell_today=[70, 30, 10, 10, 10],
            buy_names=["NewBuy", "B2", "B3", "B4", "B5"],
            buy_today=[80, 10, 10, 10, 10],
        )
    )
    later = PARSERS[4](
        _broker_parts_named(
            ts_ms=94500000,
            seq=3,
            sell_names=["Dual", "NewSell", "LaterSell", "S4", "S5"],
            sell_today=[90, 40, 60, 10, 10],
            buy_names=["NewBuy", "LaterBuy", "B3", "B4", "B5"],
            buy_today=[90, 55, 10, 10, 10],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(before + at_threshold + later, out)
    con = duckdb.connect()

    events = query_late_entry_events(con, path=out, threshold_ms=93000000)

    assert [(e.t_ms, e.broker, e.side) for e in events] == [
        (93000000, "Dual", "sell"),
        (93000000, "NewBuy", "buy"),
        (93000000, "NewSell", "sell"),
        (94500000, "LaterBuy", "buy"),
        (94500000, "LaterSell", "sell"),
    ]
    assert all(e.broker != "Dual" or e.side != "buy" for e in events)


def test_query_late_entry_events_collapses_aliases_before_selection(
    tmp_path: Path,
) -> None:
    s1 = PARSERS[4](
        _broker_parts_named(
            ts_ms=93000000,
            seq=1,
            sell_names=["신한증권", "신한투자증권", "S3", "S4", "S5"],
            sell_today=[40, 60, 10, 10, 10],
            buy_names=["B1", "B2", "B3", "B4", "B5"],
            buy_today=[10, 10, 10, 10, 10],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(s1, out)
    con = duckdb.connect()

    events = query_late_entry_events(con, path=out, threshold_ms=93000000)

    shinhan = [e for e in events if e.broker == "신한투자증권"]
    assert len(shinhan) == 1
    assert shinhan[0].side == "sell"
    assert shinhan[0].t_ms == 93000000
    assert shinhan[0].net == -100
    assert not any(e.broker == "신한증권" for e in events)


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


def test_query_day_series_orders_by_final_net_desc(tmp_path: Path) -> None:
    """Entries run from strongest net buy to strongest net sell."""
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
    assert isinstance(entries[0], BrokerSeriesEntry)
    assert entries[0].broker == "JP모간"
    assert entries[0].final_net == 79523
    assert entries[0].dominant_side == "buy"
    # KB증권 has the largest magnitude, but it is a net seller, so it belongs
    # after all net-buy brokers in final_net-desc order.
    kb = next(e for e in entries if e.broker == "KB증권")
    assert kb.final_net == -86579
    assert kb.dominant_side == "sell"
    assert entries.index(kb) > entries.index(entries[0])
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


def test_query_day_series_collapses_canonical_aliases(tmp_path: Path) -> None:
    """Hogaplay and KIS aliases for the same firm collapse to one entry.

    Without canonicalization, a parquet that contains both ``신한증권`` (KIS)
    and ``신한투자증권`` (hogaplay) rows would surface as TWO BrokerSeriesEntry —
    splitting net, splitting sparkline, and pushing legitimate brokers out
    of the top-10. See ``hoga.broker_names`` and CONTEXT.md.
    """
    # Snapshot 1 uses KIS alias, snapshot 2 uses hogaplay alias — same firm.
    s1 = PARSERS[4](
        _broker_parts_named(
            ts_ms=90000000,
            seq=1,
            sell_names=["신한증권", "X1", "X2", "X3", "X4"],
            sell_today=[500, 1, 1, 1, 1],
            buy_names=["Y1", "Y2", "Y3", "Y4", "Y5"],
            buy_today=[1, 1, 1, 1, 1],
        )
    )
    s2 = PARSERS[4](
        _broker_parts_named(
            ts_ms=100000000,
            seq=2,
            sell_names=["신한투자증권", "X1", "X2", "X3", "X4"],
            sell_today=[700, 1, 1, 1, 1],
            buy_names=["Y1", "Y2", "Y3", "Y4", "Y5"],
            buy_today=[1, 1, 1, 1, 1],
        )
    )
    out = tmp_path / "brokers.parquet"
    write_parquet(s1 + s2, out)
    con = duckdb.connect()
    entries = query_day_series(con, path=out)
    shinhan = [e for e in entries if e.broker == "신한투자증권"]
    assert len(shinhan) == 1, "alias rows must collapse, not double-count"
    assert [p.ts_ms for p in shinhan[0].points] == [90000000, 100000000]
    assert shinhan[0].points[0].net == -500
    assert shinhan[0].points[1].net == -700
    assert shinhan[0].final_net == -700
    # Raw alias must not appear independently anywhere in the result.
    assert not any(e.broker == "신한증권" for e in entries)


def test_query_day_series_returns_all_brokers(tmp_path: Path) -> None:
    """If more than 10 distinct brokers exist, every broker still ships."""
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
    assert len(entries) == 15
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


def test_query_cumulative_details_at_returns_top10_at_each_cursor(tmp_path: Path) -> None:
    import duckdb
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(
            ts_ms=90_000_000,
            seq=1,
            side="buy",
            rank=1,
            broker="키움증권",
            qty_today=100,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_000_000,
            seq=1,
            side="sell",
            rank=1,
            broker="JP모간",
            qty_today=80,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=1,
            broker="키움증권",
            qty_today=120,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="sell",
            rank=1,
            broker="JP모간",
            qty_today=200,
            qty_delta=0,
        ),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(con, path=path, t_values=[90_000_000, 90_060_000])

    assert [(r.broker, r.net, r.dominant_side) for r in out[90_000_000]] == [
        ("키움증권", 100, "buy"),
        ("JP모간", -80, "sell"),
    ]
    assert out[90_060_000][0].broker == "키움증권"
    assert out[90_060_000][0].net == 120
    assert out[90_060_000][0].dominant_side == "buy"


def test_query_cumulative_details_at_dedupes_cursors_and_returns_empty_before_first_row(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(
            ts_ms=90_000_000,
            seq=1,
            side="buy",
            rank=1,
            broker="키움증권",
            qty_today=100,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=1,
            broker="키움증권",
            qty_today=150,
            qty_delta=0,
        ),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(
            con,
            path=path,
            t_values=[89_999_999, 90_060_000, 90_060_000],
        )

    assert out[89_999_999] == []
    assert [(r.broker, r.net, r.dominant_side) for r in out[90_060_000]] == [
        ("키움증권", 150, "buy")
    ]
    assert sorted(out.keys()) == [89_999_999, 90_060_000]


def test_query_cumulative_details_at_keeps_final_day_order_at_earlier_cursor(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(
            ts_ms=90_000_000,
            seq=1,
            side="buy",
            rank=1,
            broker="A증권",
            qty_today=500,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_000_000,
            seq=1,
            side="buy",
            rank=2,
            broker="B증권",
            qty_today=100,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=1,
            broker="A증권",
            qty_today=500,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="sell",
            rank=1,
            broker="B증권",
            qty_today=1_000,
            qty_delta=0,
        ),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(con, path=path, t_values=[90_000_000])

    assert [(r.broker, r.net, r.dominant_side) for r in out[90_000_000]] == [
        ("A증권", 500, "buy"),
        ("B증권", 100, "buy"),
    ]


def test_query_cumulative_details_at_collapses_canonical_aliases_at_latest_ts(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(ts_ms=90_000_000, seq=1, side="buy", rank=1, broker="신한증권", qty_today=50, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="buy", rank=1, broker="신한증권", qty_today=120, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="sell", rank=2, broker="신한투자증권", qty_today=70, qty_delta=0),
        BrokerRow(ts_ms=90_060_000, seq=2, side="buy", rank=3, broker="키움증권", qty_today=40, qty_delta=0),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(con, path=path, t_values=[90_060_000])

    assert [(r.broker, r.net, r.dominant_side) for r in out[90_060_000]] == [
        ("신한투자증권", 50, "buy"),
        ("키움증권", 40, "buy"),
    ]


def test_query_cumulative_details_at_uses_latest_seq_within_same_ts_ms(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import BrokerRow, query_cumulative_details_at, write_parquet

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(
            ts_ms=90_060_000,
            seq=1,
            side="buy",
            rank=1,
            broker="신한증권",
            qty_today=100,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=1,
            side="sell",
            rank=2,
            broker="신한투자증권",
            qty_today=30,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=1,
            broker="신한증권",
            qty_today=70,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="sell",
            rank=2,
            broker="신한투자증권",
            qty_today=10,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=3,
            broker="키움증권",
            qty_today=40,
            qty_delta=0,
        ),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        out = query_cumulative_details_at(con, path=path, t_values=[90_060_000])

    assert [(r.broker, r.net, r.dominant_side) for r in out[90_060_000]] == [
        ("신한투자증권", 60, "buy"),
        ("키움증권", 40, "buy"),
    ]


def test_query_cumulative_details_order_matches_day_series_with_same_ts_multi_seq(
    tmp_path: Path,
) -> None:
    from hoga.tables.brokers import (
        BrokerRow,
        query_cumulative_details_at,
        query_day_series,
        write_parquet,
    )

    path = tmp_path / "brokers.parquet"
    rows = [
        BrokerRow(
            ts_ms=90_060_000,
            seq=1,
            side="buy",
            rank=1,
            broker="A증권",
            qty_today=100,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=1,
            broker="A증권",
            qty_today=1,
            qty_delta=0,
        ),
        BrokerRow(
            ts_ms=90_060_000,
            seq=2,
            side="buy",
            rank=2,
            broker="B증권",
            qty_today=60,
            qty_delta=0,
        ),
    ]
    write_parquet(rows, path)

    with duckdb.connect(":memory:") as con:
        live_order = [entry.broker for entry in query_day_series(con, path=path)]
        details = query_cumulative_details_at(con, path=path, t_values=[90_060_000])

    detail_rows = details[90_060_000]
    assert [row.broker for row in detail_rows] == live_order
    assert [(row.broker, row.net) for row in detail_rows] == [
        ("A증권", 1),
        ("B증권", 60),
    ]
