from __future__ import annotations

from hoga.tables.dispatch import FieldCountError, split_row


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
