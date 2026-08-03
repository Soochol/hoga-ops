"""Calendar policy adapters for scheduler and Live Capture callers."""

from __future__ import annotations

import asyncio
from collections.abc import Callable

from hoga.api import calendar

TradingDaysInRange = Callable[[str, str], list[str]]
TradingSessionVerdict = Callable[[str], bool | None]


def live_session_allowed_by_calendar(
    verdict_for_day: TradingSessionVerdict,
    today_yyyymmdd: str,
) -> bool:
    """Live Capture policy: missing calendar data is lenient.

    A False verdict closes the session; None means KIS chk-holiday is unavailable,
    so the clock gate remains authoritative rather than silently stopping capture.
    """
    return verdict_for_day(today_yyyymmdd) is not False


def live_session_allowed_today(today_yyyymmdd: str) -> bool:
    return live_session_allowed_by_calendar(calendar.is_trading_session_today, today_yyyymmdd)


async def daily_run_allowed_by_calendar(
    trading_days: TradingDaysInRange,
    today_yyyymmdd: str,
) -> bool | None:
    """Daily Scheduler policy: three-valued verdict.

    - ``True``  — 거래일이다. 오늘 몫을 enqueue 한다.
    - ``False`` — 거래일이 아니다(휴장). 오늘은 할 일이 없다 — **확정**된 판정.
    - ``None``  — 판정 불가(KIS chk-holiday 실패). 아직 아무것도 결론 나지 않았다.

    **``None`` 을 ``False`` 로 접으면 안 된다.** 접던 시절에는 KIS 일시 장애가
    휴장일과 똑같이 "not a trading day, skipping" INFO 한 줄로 끝났고, 호출자가
    실행 마커까지 찍어 그날 재시도가 사라졌다. hogaplay 업스트림 보유가 ~18시간
    이라 다음 날 사람이 알아챌 때면 데이터는 이미 없다 — 무인 서버에서 일시
    장애가 영구 소실이 되는 경로였다(2026-08-03).

    이 구분은 범위 캡처 enqueue 가 이미 쓰고 있는 것과 같은 원칙이다(#976):
    영구 조건(자격증명 없음)과 일시 장애는 다른 처방을 받아야 한다.
    """
    try:
        days = await asyncio.to_thread(trading_days, today_yyyymmdd, today_yyyymmdd)
    except Exception:  # noqa: BLE001 — 원인 무관하게 "판정 불가" 한 값으로 접는다
        return None
    return today_yyyymmdd in days


async def daily_run_allowed_today(today_yyyymmdd: str) -> bool | None:
    return await daily_run_allowed_by_calendar(calendar.trading_days_in_range, today_yyyymmdd)


async def trading_days_for_enqueue(
    trading_days: TradingDaysInRange,
    start_yyyymmdd: str,
    end_yyyymmdd: str,
) -> list[str]:
    """Enqueue/catch-up policy: fail fast when the calendar accessor fails."""
    return await asyncio.to_thread(trading_days, start_yyyymmdd, end_yyyymmdd)


async def trading_days_for_enqueue_range(start_yyyymmdd: str, end_yyyymmdd: str) -> list[str]:
    return await trading_days_for_enqueue(calendar.trading_days_in_range, start_yyyymmdd, end_yyyymmdd)
