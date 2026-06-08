"""Unit tests for hoga.live.session_gate.ws_capture_window."""
from datetime import datetime

from hoga.api import calendar as cal
from hoga.live.kis_client import KIS_KST
from hoga.live.session_gate import ws_capture_window


def _ms(year: int, month: int, day: int, hour: int, minute: int) -> int:
    return int(datetime(year, month, day, hour, minute, 0, tzinfo=KIS_KST).timestamp() * 1000)


def test_regular_hours_trading_day_returns_true(monkeypatch):
    """10:00 KST on a trading weekday → True."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday
    assert ws_capture_window(t) is True


def test_after_hours_closing_returns_false(monkeypatch):
    """15:45 KST — after_hours_closing phase → False even on a trading day."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 15, 45)  # Tuesday
    assert ws_capture_window(t) is False


def test_holiday_at_regular_hours_returns_false(monkeypatch):
    """should_run_now returns False (calendar says holiday) at 10:00 → False."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday but stubbed as holiday
    assert ws_capture_window(t) is False
