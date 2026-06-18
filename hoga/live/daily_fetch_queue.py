from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from hoga.live import kis_access
from hoga.live.kis_client import DailyCandleFetchResult, KisAuthError, KisRateLimitError

Lane = Literal["foreground", "background"]


@dataclass(frozen=True)
class DailyKisUnavailable(RuntimeError):
    lane: Lane
    reason: str

    def __str__(self) -> str:
        return f"Daily KIS Fetch Queue unavailable lane={self.lane} reason={self.reason}"


class DailyKisFetchQueue:
    """Priority-aware governor for KIS daily candle TR calls.

    The Daily KIS Fetch Queue is intentionally narrower than the generic KIS
    REST client: it only coordinates `inquire-daily-itemchartprice`, where
    user-visible chart backfills and screener catch-up were contending for the
    same upstream quota.
    """

    def __init__(
        self,
        *,
        acquire_account: Callable = kis_access.acquire_account_for_role,
        foreground_concurrency: int = 3,
        background_concurrency_per_account: int = 1,
        account0_background_fallback_concurrency: int = 1,
        global_rate_per_sec: float = 6.0,
        cooldown_backoff: tuple[float, ...] = (1.0, 2.0, 4.0, 8.0),
    ) -> None:
        if foreground_concurrency <= 0:
            raise ValueError("foreground_concurrency must be positive")
        if background_concurrency_per_account <= 0:
            raise ValueError("background_concurrency_per_account must be positive")
        if account0_background_fallback_concurrency <= 0:
            raise ValueError("account0_background_fallback_concurrency must be positive")
        if global_rate_per_sec <= 0:
            raise ValueError("global_rate_per_sec must be positive")

        self._acquire_account = acquire_account
        self._fg_sem = asyncio.Semaphore(foreground_concurrency)
        self._bg_per_account = background_concurrency_per_account
        self._account0_bg_sem = asyncio.Semaphore(account0_background_fallback_concurrency)
        self._global_min_interval = 1.0 / global_rate_per_sec
        self._rate_lock = asyncio.Lock()
        self._last_start = 0.0
        self._cooldown_until = 0.0
        self._cooldown_backoff = cooldown_backoff
        self._cooldown_index = 0
        self._fg_waiting = 0
        self._fg_active = 0
        self._bg_waiting = 0
        self._bg_active = 0
        self._daily_rate_limit_count = 0
        self._account_bg_sems: dict[int, asyncio.Semaphore] = {}
        self._state_lock = asyncio.Lock()

    def snapshot(self) -> dict:
        now = time.monotonic()
        return {
            "queued_foreground": self._fg_waiting,
            "queued_background": self._bg_waiting,
            "active_foreground": self._fg_active,
            "active_background": self._bg_active,
            "cooldown_remaining_ms": max(0, int((self._cooldown_until - now) * 1000)),
            "daily_rate_limit_count": self._daily_rate_limit_count,
        }

    async def fetch_past_daily_candles(
        self,
        data_dir: Path,
        *,
        lane: Lane,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        adjust: bool = True,
    ) -> DailyCandleFetchResult:
        if lane == "foreground":
            return await self._run_foreground(
                data_dir, code, from_yyyymmdd, to_yyyymmdd, adjust
            )
        if lane == "background":
            return await self._run_background(
                data_dir, code, from_yyyymmdd, to_yyyymmdd, adjust
            )
        raise ValueError(f"unknown Daily KIS Fetch Queue lane: {lane}")

    async def _run_foreground(
        self, data_dir: Path, code: str, frm: str, to: str, adjust: bool
    ) -> DailyCandleFetchResult:
        async with self._state_lock:
            self._fg_waiting += 1
        try:
            await self._fg_sem.acquire()
        except BaseException:
            async with self._state_lock:
                self._fg_waiting -= 1
            raise
        async with self._state_lock:
            self._fg_waiting -= 1
            self._fg_active += 1
        try:
            lease = self._acquire_account("foreground", data_dir)
            if lease is None:
                raise DailyKisUnavailable("foreground", "account_unavailable")
            return await self._call_lease(
                lease, data_dir, code, frm, to, adjust, foreground=True
            )
        finally:
            async with self._state_lock:
                self._fg_active -= 1
            self._fg_sem.release()

    async def _run_background(
        self, data_dir: Path, code: str, frm: str, to: str, adjust: bool
    ) -> DailyCandleFetchResult:
        self._bg_waiting += 1
        counted_waiting = True
        try:
            await self._wait_for_foreground_idle()
            lease = self._acquire_account(
                "background", data_dir, allow_account0_fallback=False
            )
            if lease is None:
                await self._wait_for_foreground_idle()
                lease = self._acquire_account(
                    "background", data_dir, allow_account0_fallback=True
                )
            if lease is None:
                raise DailyKisUnavailable("background", "account_unavailable")

            sem = (
                self._account0_bg_sem
                if lease.account_id == 0
                else self._account_bg_sems.setdefault(
                    lease.account_id,
                    asyncio.Semaphore(self._bg_per_account),
                )
            )
            async with sem:
                self._bg_waiting -= 1
                counted_waiting = False
                self._bg_active += 1
                try:
                    return await self._call_lease(
                        lease,
                        data_dir,
                        code,
                        frm,
                        to,
                        adjust,
                        foreground=False,
                        requires_foreground_idle=True,
                    )
                finally:
                    self._bg_active -= 1
        finally:
            if counted_waiting:
                self._bg_waiting -= 1

    async def _wait_for_foreground_idle(self) -> None:
        while True:
            async with self._state_lock:
                idle = self._fg_waiting == 0 and self._fg_active == 0
            if idle:
                return
            await asyncio.sleep(0.02)

    async def _call_lease(
        self,
        lease,
        data_dir: Path,
        code: str,
        frm: str,
        to: str,
        adjust: bool,
        *,
        foreground: bool,
        requires_foreground_idle: bool = False,
    ) -> DailyCandleFetchResult:
        attempts = len(self._cooldown_backoff) + 1
        current_lease = lease
        for attempt in range(attempts):
            await self._wait_global_turn(
                foreground=foreground,
                requires_foreground_idle=(
                    requires_foreground_idle
                    or current_lease.account_id == 0
                    or (not foreground and attempt > 0)
                ),
            )
            try:
                result = await current_lease.client.fetch_past_daily_candles(
                    code,
                    frm,
                    to,
                    adjust=adjust,
                    foreground=foreground,
                    retry=False,
                )
                self._cooldown_index = 0
                return result
            except KisAuthError:
                if foreground or current_lease.account_id == 0:
                    raise
                fallback = self._acquire_account(
                    "background",
                    data_dir,
                    allow_account0_fallback=True,
                )
                if fallback is None or fallback.account_id == current_lease.account_id:
                    raise
                current_lease = fallback
            except KisRateLimitError:
                self._daily_rate_limit_count += 1
                if attempt + 1 >= attempts:
                    raise
                delay = self._cooldown_backoff[
                    min(self._cooldown_index, len(self._cooldown_backoff) - 1)
                ]
                self._cooldown_index += 1
                self._cooldown_until = max(
                    self._cooldown_until, time.monotonic() + delay
                )
        raise AssertionError("unreachable")

    async def _wait_global_turn(
        self,
        *,
        foreground: bool,
        requires_foreground_idle: bool,
    ) -> None:
        while True:
            async with self._rate_lock:
                now = time.monotonic()
                wait = max(
                    0.0,
                    self._cooldown_until - now,
                    self._last_start + self._global_min_interval - now,
                )
                if wait <= 0:
                    async with self._state_lock:
                        foreground_idle = self._fg_waiting == 0 and self._fg_active == 0
                    if foreground or not requires_foreground_idle or foreground_idle:
                        self._last_start = time.monotonic()
                        return
                    wait = 0.02
            await asyncio.sleep(wait)


_queue = DailyKisFetchQueue()


def get_daily_fetch_queue() -> DailyKisFetchQueue:
    return _queue
