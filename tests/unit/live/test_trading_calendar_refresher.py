import asyncio
import datetime as dt

import pytest

from hoga.api import trading_days
from hoga.live import lifecycle
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
