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


@contextmanager
def fixture_only_trading_calendar() -> Iterator[None]:
    """Prevent measurement children from reaching the KIS calendar."""
    original = queries._is_non_trading_day
    queries._is_non_trading_day = _fixture_is_non_trading_day
    try:
        yield
    finally:
        queries._is_non_trading_day = original
