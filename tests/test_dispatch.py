from __future__ import annotations

import pytest

from hoga.tables.brokers import BrokerRow
from hoga.tables.dispatch import EXPECTED_FIELD_COUNTS, FieldCountError, parse_row, split_row
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade


def test_split_row_strips_trailing_newline() -> None:
    assert split_row("a\tb\tc\n") == ["a", "b", "c"]


def test_split_row_strips_trailing_tab_empty_field() -> None:
    assert split_row("a\tb\tc\t\n") == ["a", "b", "c"]


def test_split_row_strips_crlf() -> None:
    assert split_row("a\tb\tc\r\n") == ["a", "b", "c"]


def test_split_row_preserves_inner_empties() -> None:
    assert split_row("a\t\tb\t\t\tc") == ["a", "", "b", "", "", "c"]


def test_field_count_error_is_value_error() -> None:
    assert issubclass(FieldCountError, ValueError)


def test_registry_built_from_tables() -> None:
    assert {1, 2, 3, 4}.issubset(EXPECTED_FIELD_COUNTS.keys())
    assert 5 not in EXPECTED_FIELD_COUNTS  # type 5 is SKIP, not registered


def test_parse_trade_row() -> None:
    line = "\t".join(
        [
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
    )
    assert isinstance(parse_row(line), Trade)


def test_parse_orderbook_row() -> None:
    header = ["2", "2", "835", "847", "90000435", "32400435"]
    levels = ["0"] * 60
    totals = ["0", "0", "0", "0"]
    line = "\t".join(header + levels + totals) + "\t"
    assert isinstance(parse_row(line), Orderbook)


def test_parse_broker_row() -> None:
    header = ["2", "4", "0", "912", "90019919", "32419919"]
    names1 = ["A", "B", "C", "D", "E"]
    qty1 = ["1", "1", "1", "1", "1"]
    qty2 = ["1", "1", "1", "1", "1"]
    names2 = ["F", "G", "H", "I", "J"]
    qty3 = ["1", "1", "1", "1", "1"]
    qty4 = ["1", "1", "1", "1", "1"]
    extras = ["0", "0", "0", "0", "0", "0"]
    line = "\t".join(header + names1 + qty1 + qty2 + names2 + qty3 + qty4 + extras)
    result = parse_row(line)
    assert isinstance(result, list)
    assert all(isinstance(r, BrokerRow) for r in result)


def test_skip_price_tick_returns_none() -> None:
    assert parse_row("3\t5\t25700") is None


def test_unknown_event_type_raises() -> None:
    with pytest.raises(ValueError, match="unknown event type"):
        parse_row("2\t9\t0\t1\t90000000\t0")


def test_wrong_field_count_raises() -> None:
    with pytest.raises(FieldCountError):
        parse_row("2\t1\t0\t1\t90000000")
