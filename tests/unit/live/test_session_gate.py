"""Unit tests for hoga.live.session_gate.ws_capture_window."""
from datetime import datetime

import pytest

from hoga.api import calendar as cal
from hoga.live.kis_client import KIS_KST
from hoga.live.session_gate import ws_capture_window, ws_capture_window_async


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


@pytest.mark.asyncio
async def test_async_wrapper_matches_sync(monkeypatch):
    """ws_capture_window_async(non-blocking 진입점, to_thread 봉인)는 sync와 동일 결과 —
    blocking 계약을 시그니처에 박되 동작은 보존(C4 계약 명시화)."""
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: True)
    t = _ms(2026, 5, 27, 10, 0)  # Tuesday 10:00
    assert await ws_capture_window_async(t) is True
    monkeypatch.setattr(cal, "is_trading_session_today", lambda d: False)
    assert await ws_capture_window_async(t) is False
