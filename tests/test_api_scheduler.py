"""Scheduler unit tests. See spec 2026-05-26 + ADR-0034."""
from __future__ import annotations

import datetime as dt
from zoneinfo import ZoneInfo

import pytest


KST = ZoneInfo("Asia/Seoul")


def _at(h: int, m: int = 0, day: int = 26) -> dt.datetime:
    return dt.datetime(2026, 5, day, h, m, 0, tzinfo=KST)


def test_before_18_returns_today_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(17, 59))
    assert 50 < secs < 70


def test_at_exactly_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 0))
    assert secs == pytest.approx(24 * 3600, abs=2)


def test_after_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 1))
    # 23h 59m to tomorrow's 18:00.
    assert 23 * 3600 + 59 * 60 - 2 < secs < 23 * 3600 + 59 * 60 + 2


def test_midnight_returns_18h():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(0, 0))
    assert secs == pytest.approx(18 * 3600, abs=2)
