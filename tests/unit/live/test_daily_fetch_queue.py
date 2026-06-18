from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path

import pytest

from hoga.live.daily_fetch_queue import DailyKisFetchQueue, DailyKisUnavailable
from hoga.live.kis_client import DailyCandleFetchResult, KisAuthError, KisRateLimitError


@dataclass
class _Lease:
    role: str
    account_id: int
    client: object


class _Client:
    def __init__(self, name: str, calls: list[str], fail_rate_limit: bool = False):
        self.name = name
        self.calls = calls
        self.fail_rate_limit = fail_rate_limit

    async def fetch_past_daily_candles(
        self, code, frm, to, *, adjust=True, foreground=False, retry=True
    ):
        self.calls.append(f"{self.name}:{code}:fg={foreground}:retry={retry}")
        if self.fail_rate_limit:
            raise KisRateLimitError("EGW00201")
        return DailyCandleFetchResult(candles=[], violations=[])


class _RateLimitOnceClient(_Client):
    async def fetch_past_daily_candles(
        self, code, frm, to, *, adjust=True, foreground=False, retry=True
    ):
        self.calls.append(f"{self.name}:{code}:fg={foreground}:retry={retry}")
        if len(self.calls) == 1:
            raise KisRateLimitError("EGW00201")
        return DailyCandleFetchResult(candles=[], violations=[])


class _AuthFailClient(_Client):
    async def fetch_past_daily_candles(
        self, code, frm, to, *, adjust=True, foreground=False, retry=True
    ):
        self.calls.append(f"{self.name}:{code}:fg={foreground}:retry={retry}")
        raise KisAuthError("auth failed")


@pytest.mark.asyncio
async def test_background_waits_while_foreground_is_waiting(tmp_path: Path) -> None:
    calls: list[str] = []
    release_fg = asyncio.Event()

    class SlowForeground(_Client):
        async def fetch_past_daily_candles(self, *args, **kwargs):
            await release_fg.wait()
            return await super().fetch_past_daily_candles(*args, **kwargs)

    fg_client = SlowForeground("fg", calls)
    bg_client = _Client("bg", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, fg_client)
        return _Lease(role, 1, bg_client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    fg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)
    bg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="background", code="BG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)

    assert calls == []
    release_fg.set()
    await asyncio.gather(bg, fg)

    assert calls == ["fg:FG:fg=True:retry=False", "bg:BG:fg=False:retry=False"]


@pytest.mark.asyncio
async def test_background_account0_fallback_waits_for_foreground_idle(tmp_path: Path) -> None:
    calls: list[str] = []
    fg_started = asyncio.Event()
    release_fg = asyncio.Event()

    class SlowForeground(_Client):
        async def fetch_past_daily_candles(self, *args, **kwargs):
            fg_started.set()
            await release_fg.wait()
            return await super().fetch_past_daily_candles(*args, **kwargs)

    fg_client = SlowForeground("fg", calls)
    fallback_client = _Client("fallback", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, fg_client)
        if allow_account0_fallback:
            return _Lease(role, 0, fallback_client)
        return None

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    fg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await fg_started.wait()
    bg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="background", code="BG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)

    assert calls == []
    release_fg.set()
    await asyncio.gather(fg, bg)
    assert calls == ["fg:FG:fg=True:retry=False", "fallback:BG:fg=False:retry=False"]


@pytest.mark.asyncio
async def test_rate_limit_sets_cooldown_and_records_status(tmp_path: Path) -> None:
    calls: list[str] = []
    client = _Client("fg", calls, fail_rate_limit=True)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        return _Lease(role, 0, client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.01,),
    )

    with pytest.raises(KisRateLimitError):
        await queue.fetch_past_daily_candles(
            tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
        )

    snap = queue.snapshot()
    assert snap["daily_rate_limit_count"] == 2
    assert snap["cooldown_remaining_ms"] >= 0


@pytest.mark.asyncio
async def test_rate_limit_retries_inside_queue(tmp_path: Path) -> None:
    calls: list[str] = []
    client = _RateLimitOnceClient("fg", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        return _Lease(role, 0, client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    await queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    )

    assert calls == ["fg:FG:fg=True:retry=False", "fg:FG:fg=True:retry=False"]
    assert queue.snapshot()["daily_rate_limit_count"] == 1


@pytest.mark.asyncio
async def test_background_retry_yields_to_foreground_after_cooldown(tmp_path: Path) -> None:
    calls: list[str] = []
    bg_retry_ready = asyncio.Event()
    release_fg = asyncio.Event()

    class BackgroundRateLimitOnce(_Client):
        async def fetch_past_daily_candles(self, code, frm, to, *, adjust=True, foreground=False, retry=True):
            self.calls.append(f"{self.name}:{code}:fg={foreground}:retry={retry}")
            if len([c for c in self.calls if c.startswith(f"{self.name}:")]) == 1:
                raise KisRateLimitError("EGW00201")
            bg_retry_ready.set()
            return DailyCandleFetchResult(candles=[], violations=[])

    class SlowForeground(_Client):
        async def fetch_past_daily_candles(self, *args, **kwargs):
            await release_fg.wait()
            return await super().fetch_past_daily_candles(*args, **kwargs)

    bg_client = BackgroundRateLimitOnce("bg", calls)
    fg_client = SlowForeground("fg", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, fg_client)
        return _Lease(role, 1, bg_client)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.01,),
    )

    bg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="background", code="BG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0)
    fg = asyncio.create_task(queue.fetch_past_daily_candles(
        tmp_path, lane="foreground", code="FG", from_yyyymmdd="20240101", to_yyyymmdd="20240101",
    ))
    await asyncio.sleep(0.03)

    assert calls == ["bg:BG:fg=False:retry=False"]
    assert not bg_retry_ready.is_set()
    release_fg.set()
    await asyncio.gather(fg, bg)
    assert calls == [
        "bg:BG:fg=False:retry=False",
        "fg:FG:fg=True:retry=False",
        "bg:BG:fg=False:retry=False",
    ]


@pytest.mark.asyncio
async def test_background_first_attempt_yields_to_foreground_after_rate_wait(tmp_path: Path) -> None:
    queue = DailyKisFetchQueue(
        acquire_account=lambda role, data_dir, *, allow_account0_fallback=True: None,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    async with queue._state_lock:
        queue._fg_waiting = 1

    bg_turn = asyncio.create_task(
        queue._wait_global_turn(foreground=False, requires_foreground_idle=True)
    )
    await asyncio.sleep(0.03)
    assert not bg_turn.done()

    async with queue._state_lock:
        queue._fg_waiting = 0

    await asyncio.wait_for(bg_turn, timeout=1)


@pytest.mark.asyncio
async def test_background_auth_failure_falls_back_to_account0(tmp_path: Path) -> None:
    calls: list[str] = []
    acct1 = _AuthFailClient("acct1", calls)
    acct0 = _Client("acct0", calls)

    def acquire(role, data_dir, *, allow_account0_fallback=True):
        if role == "foreground":
            return _Lease(role, 0, acct0)
        if allow_account0_fallback:
            return _Lease(role, 0, acct0)
        return _Lease(role, 1, acct1)

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        foreground_concurrency=1,
        background_concurrency_per_account=1,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    await queue.fetch_past_daily_candles(
        tmp_path,
        lane="background",
        code="BG",
        from_yyyymmdd="20240101",
        to_yyyymmdd="20240101",
    )

    assert calls == [
        "acct1:BG:fg=False:retry=False",
        "acct0:BG:fg=False:retry=False",
    ]


@pytest.mark.asyncio
async def test_missing_account_raises_typed_unavailable(tmp_path: Path) -> None:
    def acquire(role, data_dir, *, allow_account0_fallback=True):
        return None

    queue = DailyKisFetchQueue(
        acquire_account=acquire,
        global_rate_per_sec=1000,
        cooldown_backoff=(0.0,),
    )

    with pytest.raises(DailyKisUnavailable) as exc:
        await queue.fetch_past_daily_candles(
            tmp_path,
            lane="foreground",
            code="FG",
            from_yyyymmdd="20240101",
            to_yyyymmdd="20240101",
        )

    assert exc.value.lane == "foreground"
    assert exc.value.reason == "account_unavailable"
