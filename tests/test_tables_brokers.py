from __future__ import annotations

from pathlib import Path

import duckdb
import pyarrow.parquet as pq

from hoga.tables.brokers import (
    PARQUET_SCHEMA,
    PARSERS,
    ApiBrokerEntry,
    BrokerRow,
    BrokersAt,
    query_at,
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


def test_query_at_returns_brokers_at_with_entries(tmp_path: Path) -> None:
    earlier = PARSERS[4](_broker_parts(ts_ms=90019919, seq=912))
    later = PARSERS[4](_broker_parts(ts_ms=90030000, seq=913))
    out = tmp_path / "brokers.parquet"
    write_parquet(earlier + later, out)
    con = duckdb.connect()
    result = query_at(con, path=out, t_ms=90025000)
    assert isinstance(result, BrokersAt)
    assert result.ts_ms == 90019919
    assert len(result.entries) == 10
    assert all(isinstance(e, ApiBrokerEntry) for e in result.entries)
    assert {e.side for e in result.entries} == {"buy", "sell"}


def test_query_at_returns_empty_brokers_at_before_any_data(tmp_path: Path) -> None:
    rows = PARSERS[4](_broker_parts())
    out = tmp_path / "brokers.parquet"
    write_parquet(rows, out)
    con = duckdb.connect()
    result = query_at(con, path=out, t_ms=80000000)
    assert isinstance(result, BrokersAt)
    assert result.ts_ms is None
    assert result.entries == []
