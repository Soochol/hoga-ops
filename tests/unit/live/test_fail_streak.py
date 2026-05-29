"""Unit tests for hoga.api.fail_streak — read-side helpers (ADR-0042)."""
from __future__ import annotations

from hoga.api.fail_streak import ATTEMPT_CAP, is_blocked, read_fail_streak, streak_key
from hoga.api.models import QueueManifest


def _empty() -> QueueManifest:
    return QueueManifest(paused=False, items=[])


def test_streak_key_format() -> None:
    assert streak_key("005930", "20260520") == "005930|20260520"


def test_read_fail_streak_missing_key_returns_zero() -> None:
    assert read_fail_streak(_empty(), "005930", "20260520") == 0


def test_read_fail_streak_present_returns_value() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    assert read_fail_streak(m, "005930", "20260520") == 3


def test_attempt_cap_is_5() -> None:
    assert ATTEMPT_CAP == 5


def test_is_blocked_below_threshold() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    assert is_blocked(m, "005930", "20260520") is False


def test_is_blocked_at_threshold() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 5})
    assert is_blocked(m, "005930", "20260520") is True


def test_is_blocked_above_threshold() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 6})
    assert is_blocked(m, "005930", "20260520") is True


def test_is_blocked_missing_key_is_false() -> None:
    assert is_blocked(_empty(), "005930", "20260520") is False
