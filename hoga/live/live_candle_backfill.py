from __future__ import annotations

import asyncio
import time as monotonic_time
from collections.abc import Awaitable, Callable, Hashable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from typing import Protocol

from hoga.live import kis_access
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_client import KisApiError, KisClient, KisRateLimitError
from hoga.live.kis_venue import (
    KisVenue,
    LiveVenuePolicy,
    merge_auto_minute_bars,
)
from hoga.live.past_candles_cache import PastCandlesCache

_KST = timezone(timedelta(hours=9))
_WEEKEND_START_WEEKDAY = 5


class KisRestScheduler(Protocol):
    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: kis_access.KisRequestPriority,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ): ...


@dataclass(frozen=True)
class LiveMinuteCandleBackfillResult:
    candles: list[dict]
    cached_dates: list[str]
    fresh_dates: list[str]
    data_warnings: list[dict]

    def model_dump(self) -> dict:
        return {
            "candles": self.candles,
            "cached_dates": self.cached_dates,
            "fresh_dates": self.fresh_dates,
            "data_warnings": self.data_warnings,
        }


class LiveMinuteCandleBackfill:
    """Owns Live Candle Backfill minute cache, scheduling, and warnings."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastCandlesCache,
        scheduler: KisRestScheduler,
        concurrency: int = 3,
        rate_limit_cooldown_s: float = 10.0,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._sem = asyncio.Semaphore(concurrency)
        self._rate_limit_cooldown_s = rate_limit_cooldown_s
        self._inflight: dict[
            tuple[KisVenue, str, str],
            asyncio.Task[tuple[list[dict], str | None]],
        ] = {}
        self._rate_limit_until = 0.0

    async def collect_minute(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
    ) -> LiveMinuteCandleBackfillResult:
        if policy == "AUTO":
            krx_out, nxt_out = await asyncio.gather(
                self._collect_for_venue("KRX", code=code, frm=frm, too=too, today_d=today_d),
                self._collect_for_venue("NXT", code=code, frm=frm, too=too, today_d=today_d),
            )
            return LiveMinuteCandleBackfillResult(
                candles=merge_auto_minute_bars(
                    krx_out.candles,
                    nxt_out.candles,
                    hhmmss_for_t_ms=_hhmmss_from_t_ms,
                ),
                cached_dates=sorted(set(krx_out.cached_dates) | set(nxt_out.cached_dates)),
                fresh_dates=sorted(set(krx_out.fresh_dates) | set(nxt_out.fresh_dates)),
                data_warnings=krx_out.data_warnings + nxt_out.data_warnings,
            )
        return await self._collect_for_venue(
            policy,
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )

    async def _collect_for_venue(
        self,
        venue: KisVenue,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
    ) -> LiveMinuteCandleBackfillResult:
        today_s = today_d.strftime("%Y%m%d")
        rows: dict[str, list[dict]] = {}
        cached_dates: list[str] = []
        pending: list[str] = []
        warnings_by_date: dict[str, dict] = {}
        fresh: set[str] = set()

        for date_s in _date_iter(frm, too):
            if date_s >= today_s:
                continue
            bars = self._cache.get_past(venue, code, date_s)
            if bars is None:
                pending.append(date_s)
            else:
                rows[date_s] = bars
                cached_dates.append(date_s)

        blocked = asyncio.Event()

        async def one(date_s: str) -> None:
            async with self._sem:
                if blocked.is_set() or self._rate_limited_now():
                    warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
                    return
                try:
                    bars, write_err = await self._fetch_past_shared(venue, code, date_s)
                except KisCapacityOverloaded:
                    warnings_by_date[date_s] = _capacity_overloaded_warning(date_s)
                    return
                except KisCapacityCooldown:
                    warnings_by_date[date_s] = self._rate_limit_aborted_warning(date_s)
                    return
                except KisRateLimitError as e:
                    blocked.set()
                    self._mark_rate_limited()
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "kis_rate_limit",
                        "msg": str(e),
                    }
                    return
                except KisApiError as e:
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "kis_api_error",
                        "msg": e.msg_cd,
                    }
                    return
                rows[date_s] = bars
                fresh.add(date_s)
                if write_err is not None:
                    warnings_by_date[date_s] = {
                        "date": date_s,
                        "reason": "cache_write_failed",
                        "msg": write_err,
                    }

        await asyncio.gather(*(one(d) for d in pending))

        candles_all: list[dict] = []
        fresh_dates: list[str] = []
        warnings: list[dict] = []
        kis_blocked = blocked.is_set()

        for date_s in _date_iter(frm, too):
            if date_s < today_s:
                if date_s in rows:
                    candles_all.extend(rows[date_s])
                    if date_s in fresh:
                        fresh_dates.append(date_s)
                if date_s in warnings_by_date:
                    warnings.append(warnings_by_date[date_s])
                continue
            try:
                state, today_bars = self._cache.get_today_tri(venue, code)
                if state == "hit":
                    assert today_bars is not None
                    bars = today_bars
                    cached_dates.append(date_s)
                elif state == "negative":
                    bars = []
                else:
                    if today_d.weekday() >= _WEEKEND_START_WEEKDAY:
                        self._cache.store_today(venue, code, None)
                        continue
                    if kis_blocked or self._rate_limited_now():
                        warnings.append(self._rate_limit_aborted_warning(date_s))
                        continue
                    bars, _write_err = await kis_access.run_with_capacity(
                        self._scheduler,
                        data_dir=self._data_dir,
                        role="foreground",
                        key=("live-candle-backfill", "minute", venue, code, date_s, "today"),
                        endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
                        priority="user_visible",
                        cooldown_scope=venue,
                        fetch_fn=lambda kis: self._fetch_past_today_once(
                            kis,
                            venue,
                            code,
                            date_s,
                        ),
                    )
                    if bars:
                        self._cache.store_today(venue, code, bars)
                        fresh_dates.append(date_s)
                    else:
                        self._cache.store_today(venue, code, None)
                candles_all.extend(bars)
            except KisRateLimitError as e:
                warnings.append({"date": date_s, "reason": "kis_rate_limit", "msg": str(e)})
                self._mark_rate_limited()
                kis_blocked = True
            except KisCapacityCooldown:
                warnings.append(self._rate_limit_aborted_warning(date_s))
            except KisCapacityOverloaded:
                warnings.append(_capacity_overloaded_warning(date_s))
            except KisApiError as e:
                warnings.append({"date": date_s, "reason": "kis_api_error", "msg": e.msg_cd})

        return LiveMinuteCandleBackfillResult(
            candles=candles_all,
            cached_dates=cached_dates,
            fresh_dates=fresh_dates,
            data_warnings=warnings,
        )

    async def _fetch_past_shared(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> tuple[list[dict], str | None]:
        key = (venue, code, date_s)
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch_past_scheduled(venue, code, date_s))
            self._inflight[key] = task
            task.add_done_callback(lambda _t, k=key: self._inflight.pop(k, None))
        return await task

    async def _fetch_past_scheduled(
        self,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> tuple[list[dict], str | None]:
        return await kis_access.run_with_capacity(
            self._scheduler,
            data_dir=self._data_dir,
            role="foreground",
            key=("live-candle-backfill", "minute", venue, code, date_s),
            endpoint=kis_access.KisRestEndpoint.PAST_MINUTE,
            priority="user_visible",
            cooldown_scope=venue,
            fetch_fn=lambda kis: self._fetch_past_once(kis, venue, code, date_s),
        )

    async def _fetch_past_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> tuple[list[dict], str | None]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        bars = [_candle_to_dict(c) for c in raw]
        try:
            self._cache.store_past(venue, code, date_s, bars)
        except OSError as e:
            return bars, str(e)
        return bars, None

    async def _fetch_past_today_once(
        self,
        kis: KisClient,
        venue: KisVenue,
        code: str,
        date_s: str,
    ) -> tuple[list[dict], str | None]:
        raw = await kis.fetch_past_minute_candles(
            code,
            date_s,
            venue=venue,
            foreground=True,
        )
        return [_candle_to_dict(c) for c in raw], None

    def _rate_limited_now(self) -> bool:
        return monotonic_time.monotonic() < self._rate_limit_until

    def _mark_rate_limited(self) -> None:
        self._rate_limit_until = max(
            self._rate_limit_until,
            monotonic_time.monotonic() + self._rate_limit_cooldown_s,
        )

    def _rate_limit_aborted_warning(self, date_s: str) -> dict:
        return {
            "date": date_s,
            "reason": "rate_limit_aborted",
            "msg": "KIS rate limit cooldown active",
        }


def _date_iter(frm: date, to: date):
    cur = frm
    while cur <= to:
        yield cur.strftime("%Y%m%d")
        cur = cur + timedelta(days=1)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "volume": c.volume,
    }


def _hhmmss_from_t_ms(t_ms: int) -> str:
    return datetime.fromtimestamp(t_ms / 1000, tz=_KST).strftime("%H%M%S")


def _capacity_overloaded_warning(date_s: str) -> dict:
    return {
        "date": date_s,
        "reason": "capacity_overloaded",
        "msg": "KIS capacity scheduler pending request limit reached",
    }
