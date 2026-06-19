from __future__ import annotations

import pytest


def test_live_calendar_policy_is_lenient_on_unavailable() -> None:
    from hoga.api.calendar_policy import live_session_allowed_by_calendar

    assert live_session_allowed_by_calendar(lambda _today: None, "20260605") is True
    assert live_session_allowed_by_calendar(lambda _today: True, "20260605") is True
    assert live_session_allowed_by_calendar(lambda _today: False, "20260605") is False


@pytest.mark.asyncio
async def test_daily_calendar_policy_fails_closed_on_unavailable() -> None:
    from hoga.api.calendar import TradingDayUnavailableError
    from hoga.api.calendar_policy import daily_run_allowed_by_calendar
    from hoga.api.error_codes import UpstreamCode

    def unavailable(_start: str, _end: str) -> list[str]:
        raise TradingDayUnavailableError(UpstreamCode.KIS_HOLIDAY_FETCH_FAILED)

    assert await daily_run_allowed_by_calendar(unavailable, "20260605") is False


@pytest.mark.asyncio
async def test_daily_calendar_policy_allows_only_returned_trading_day() -> None:
    from hoga.api.calendar_policy import daily_run_allowed_by_calendar

    assert await daily_run_allowed_by_calendar(lambda _s, _e: ["20260605"], "20260605") is True
    assert await daily_run_allowed_by_calendar(lambda _s, _e: [], "20260605") is False


@pytest.mark.asyncio
async def test_trading_days_for_enqueue_uses_fail_fast_accessor() -> None:
    from hoga.api.calendar_policy import trading_days_for_enqueue

    assert await trading_days_for_enqueue(lambda _s, _e: ["20260604", "20260605"], "20260604", "20260605") == [
        "20260604",
        "20260605",
    ]
