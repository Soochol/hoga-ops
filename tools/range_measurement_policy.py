"""Hermetic policies shared by Range measurement entry points."""

from __future__ import annotations

from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime

from hoga.api import queries

TRADING_CALENDAR_POLICY = "fixture-weekday-lenient-v1"
_WEEKEND_START = 5


def _fixture_is_non_trading_day(date_yyyymmdd: str) -> bool:
    """Exclude weekends locally; treat weekdays as fixture-declared data."""
    try:
        return datetime.strptime(date_yyyymmdd, "%Y%m%d").weekday() >= _WEEKEND_START
    except ValueError:
        return False


def _fixture_is_confirmed_trading_day(date_yyyymmdd: str) -> bool:
    """Same fixture policy for the missing-date reporter's predicate.

    Both predicates must be patched together — they ask the same question with
    opposite leniency, so patching one leaves the other reaching the calendar.
    """
    return not _fixture_is_non_trading_day(date_yyyymmdd)


@contextmanager
def fixture_only_trading_calendar() -> Iterator[None]:
    """Prevent measurement children from reaching the KIS calendar."""
    original = queries._is_non_trading_day
    original_confirmed = queries._is_confirmed_trading_day
    queries._is_non_trading_day = _fixture_is_non_trading_day
    queries._is_confirmed_trading_day = _fixture_is_confirmed_trading_day
    try:
        yield
    finally:
        queries._is_non_trading_day = original
        queries._is_confirmed_trading_day = original_confirmed
