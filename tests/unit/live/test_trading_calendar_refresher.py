import asyncio
import datetime as dt

import pytest

from hoga.api import trading_days
from hoga.live import lifecycle
from hoga.live.kiwoom_errors import KiwoomApiError, KiwoomTerminalAuthError
from hoga.util.timeenc import KST


async def test_refresher_wakes_at_open_rechecks_missing_day_and_then_returns_to_slow_poll(
    tmp_path, monkeypatch,
):
    now = dt.datetime(2026, 10, 20, 8, 59, 30, tzinfo=KST)
    days = {"20261019"}
    checks, delays = [], []
    monkeypatch.setattr(lifecycle.time, "time", lambda: now.timestamp())
    monkeypatch.setattr(trading_days, "trading_days", lambda _: days)

    async def refresh(_):
        checks.append(now.strftime("%H:%M:%S"))
        # The first index bar has not arrived right at 09:00.
        if now >= dt.datetime(2026, 10, 20, 9, 1, tzinfo=KST):
            days.add("20261020")
        return 0

    async def sleep(delay):
        nonlocal now
        delays.append(delay)
        if len(delays) == 3:
            raise asyncio.CancelledError
        now += dt.timedelta(seconds=delay)

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await lifecycle.start_trading_calendar_refresher(tmp_path)
    assert checks == ["08:59:30", "09:00:00", "09:01:00"]
    assert delays == [30, 60, 21600]


async def test_service_failure_retries_after_close_and_restores_normal_interval(
    tmp_path, monkeypatch, caplog,
):
    now = dt.datetime(2026, 11, 2, 16, 30, tzinfo=KST)
    checks, delays = [], []
    monkeypatch.setattr(lifecycle.time, "time", lambda: now.timestamp())

    async def refresh(_):
        checks.append(now)
        if len(checks) == 1:
            raise KiwoomApiError(7, "서비스를 처리하는 중에 오류가 발생했습니다[1631]")
        trading_days.append_overlay(tmp_path, ["20261102"])
        return 1

    async def sleep(delay):
        nonlocal now
        delays.append(delay)
        if len(delays) == 2:
            raise asyncio.CancelledError
        now += dt.timedelta(seconds=delay)

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    with caplog.at_level("INFO"), pytest.raises(asyncio.CancelledError):
        await lifecycle.start_trading_calendar_refresher(tmp_path)

    assert delays == [60, 21600]
    assert checks[1] == checks[0] + dt.timedelta(minutes=1)
    assert trading_days.is_trading_day("20261102", tmp_path) is True
    assert "live.trading_calendar.refresh_retry" in caplog.text
    assert "live.trading_calendar.refresh_recovered" in caplog.text


async def test_persistent_service_failure_backs_off_and_success_resets_retry(
    tmp_path, monkeypatch,
):
    now = dt.datetime(2026, 11, 2, 16, 30, tzinfo=KST)
    attempts, delays = 0, []
    monkeypatch.setattr(lifecycle.time, "time", lambda: now.timestamp())

    async def refresh(_):
        nonlocal attempts
        attempts += 1
        if attempts != 7:
            raise KiwoomApiError("7", "서비스를 처리하는 중에 오류가 발생했습니다[1631]")
        return 0

    async def sleep(delay):
        nonlocal now
        delays.append(delay)
        if len(delays) == 8:
            raise asyncio.CancelledError
        now += dt.timedelta(seconds=delay)

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await lifecycle.start_trading_calendar_refresher(tmp_path)
    assert attempts == 8
    assert delays == [60, 120, 240, 480, 900, 900, 21600, 60]


@pytest.mark.parametrize("error", [
    KiwoomApiError(7, "다른 오류[1999]"),
    KiwoomApiError(1, "서비스를 처리하는 중에 오류가 발생했습니다[1631]"),
    KiwoomApiError(2, "필수 파라미터 누락[1511]"),
    KiwoomTerminalAuthError(3, "인증에 실패했습니다[8050:IP가 등록되지 않았습니다]"),
    RuntimeError("internal defect"),
])
async def test_other_failures_remain_visible_without_fast_retry(
    tmp_path, monkeypatch, caplog, error,
):
    now = dt.datetime(2026, 11, 2, 16, 30, tzinfo=KST)
    monkeypatch.setattr(lifecycle.time, "time", lambda: now.timestamp())
    delays = []

    async def refresh(_):
        raise error

    async def sleep(delay):
        delays.append(delay)
        raise asyncio.CancelledError

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await lifecycle.start_trading_calendar_refresher(tmp_path)
    assert delays == [21600]
    assert "live.trading_calendar.refresh_failed" in caplog.text
    assert "live.trading_calendar.refresh_retry" not in caplog.text


async def test_retry_does_not_delay_the_market_open_check(tmp_path, monkeypatch):
    now = dt.datetime(2026, 11, 2, 8, 59, 30, tzinfo=KST)
    monkeypatch.setattr(lifecycle.time, "time", lambda: now.timestamp())
    delays = []

    async def refresh(_):
        raise KiwoomApiError(7, "서비스를 처리하는 중에 오류가 발생했습니다[1631]")

    async def sleep(delay):
        delays.append(delay)
        raise asyncio.CancelledError

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    with pytest.raises(asyncio.CancelledError):
        await lifecycle.start_trading_calendar_refresher(tmp_path)
    assert delays == [30]


async def test_stopping_refresher_cancels_retry_without_another_request(tmp_path, monkeypatch):
    waiting = asyncio.Event()
    attempts = 0
    original_sleep = asyncio.sleep

    async def refresh(_):
        nonlocal attempts
        attempts += 1
        raise KiwoomApiError(7, "서비스를 처리하는 중에 오류가 발생했습니다[1631]")

    async def sleep(_):
        waiting.set()
        await original_sleep(3600)

    monkeypatch.setattr(trading_days, "refresh_overlay", refresh)
    monkeypatch.setattr(lifecycle.asyncio, "sleep", sleep)
    task = lifecycle.start_trading_calendar_refresher(tmp_path)
    try:
        await asyncio.wait_for(waiting.wait(), timeout=1)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=1)
        assert attempts == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
