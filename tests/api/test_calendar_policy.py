from __future__ import annotations

import pytest


def test_live_calendar_policy_is_lenient_on_unavailable() -> None:
    from hoga.api.calendar_policy import live_session_allowed_by_calendar

    assert live_session_allowed_by_calendar(lambda _today: None, "20260605") is True
    assert live_session_allowed_by_calendar(lambda _today: True, "20260605") is True
    assert live_session_allowed_by_calendar(lambda _today: False, "20260605") is False


@pytest.mark.asyncio
async def test_daily_calendar_policy_reports_unavailable_as_undecided() -> None:
    """판정 불가는 '휴장(False)' 이 아니라 None 이다.

    접어 버리면 KIS 일시 장애가 휴장일과 똑같이 처리돼 호출자가 실행 마커를 찍고,
    그날 관심종목 enqueue 가 재시도 없이 사라진다 — hogaplay 보유가 ~18시간이라
    다음 날엔 복구 불가다(2026-08-03).
    """
    from hoga.api.calendar import TradingDayUnavailableError
    from hoga.api.calendar_policy import daily_run_allowed_by_calendar
    from hoga.api.error_codes import UpstreamCode

    def unavailable(_start: str, _end: str) -> list[str]:
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_UNAVAILABLE)

    assert await daily_run_allowed_by_calendar(unavailable, "20260605") is None


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
