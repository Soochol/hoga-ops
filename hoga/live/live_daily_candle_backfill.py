from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date, datetime, timedelta, timezone
from typing import Protocol

from hoga.live import kis_access
from hoga.live.kis_capacity_scheduler import (
    KisCapacityCooldown,
    KisCapacityOverloaded,
)
from hoga.live.kis_client import KisClient, KisRateLimitError
from hoga.live.kis_venue import (
    KisVenue,
    LiveVenuePolicy,
    daily_venue_for_policy,
)
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache

_KST = timezone(timedelta(hours=9))


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


Walkback = Callable[
    ...,
    Awaitable[dict],
]


class LiveDailyCandleBackfill:
    """Owns Live Candle Backfill daily venue fallback and warning policy."""

    def __init__(
        self,
        *,
        data_dir,
        cache: PastDailyCandlesCache,
        scheduler: KisRestScheduler,
        walkback: Walkback,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._walkback = walkback

    async def collect_daily(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
        policy: LiveVenuePolicy,
        from_label: str,
        to_label: str,
    ) -> dict:
        venue = daily_venue_for_policy(policy)
        fallback_warnings: list[dict] = []

        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await self._fetch_primary_batch(
                venue=venue,
                code=code_,
                from_s=from_s,
                to_s=to_s,
            )
            if venue != "KRX" and not result.violations and _needs_krx_daily_fill(
                result.candles,
                from_s,
                to_s,
            ):
                fallback = await self._fetch_krx_fallback_batch(
                    code=code_,
                    from_s=from_s,
                    to_s=to_s,
                )
                if fallback.candles:
                    batch = f"{from_s}__{to_s}"
                    if result.candles:
                        fallback_warnings.append(
                            _daily_partial_fallback_to_krx_warning(venue, batch)
                        )
                        result = type(result)(
                            candles=_merge_daily_fallback(result.candles, fallback.candles),
                            violations=result.violations,
                        )
                    else:
                        fallback_warnings.append(
                            _daily_fallback_to_krx_warning(venue, batch)
                        )
                        result = fallback
            return [_candle_to_dict(c) for c in result.candles], result.violations

        out = await self._walkback(
            cache=_VenueDailyCacheAdapter(self._cache, venue),  # type: ignore[arg-type]
            fetch_batch=fetch_batch,
            output_key="candles",
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )
        out["venue"] = policy
        out["data_warnings"].extend(fallback_warnings)
        return out

    async def _fetch_primary_batch(
        self,
        *,
        venue: KisVenue,
        code: str,
        from_s: str,
        to_s: str,
    ):
        try:
            return await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                role="foreground",
                key=("live-candle-backfill", "daily", venue, code, from_s, to_s),
                endpoint=kis_access.KisRestEndpoint.PAST_DAILY,
                priority="user_visible",
                cooldown_scope=venue,
                fetch_fn=lambda kis: kis.fetch_past_daily_candles(
                    code,
                    from_s,
                    to_s,
                    venue=venue,
                    foreground=True,
                ),
            )
        except (KisCapacityCooldown, KisCapacityOverloaded) as e:
            raise KisRateLimitError(str(e)) from e

    async def _fetch_krx_fallback_batch(
        self,
        *,
        code: str,
        from_s: str,
        to_s: str,
    ):
        try:
            return await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                role="foreground",
                key=("live-candle-backfill", "daily", "KRX", code, from_s, to_s, "fallback"),
                endpoint=kis_access.KisRestEndpoint.PAST_DAILY,
                priority="user_visible",
                cooldown_scope="KRX",
                fetch_fn=lambda kis: kis.fetch_past_daily_candles(
                    code,
                    from_s,
                    to_s,
                    venue="KRX",
                    foreground=True,
                ),
            )
        except (KisCapacityCooldown, KisCapacityOverloaded) as e:
            raise KisRateLimitError(str(e)) from e


class _VenueDailyCacheAdapter:
    def __init__(self, inner: PastDailyCandlesCache, venue: KisVenue) -> None:
        self._inner = inner
        self._venue = venue

    def list_batches(self, code: str):
        return self._inner.list_batches(self._venue, code)

    def append_batch(self, code: str, frm: date, to: date, bars: list[dict]) -> None:
        self._inner.append_batch(self._venue, code, frm, to, bars)

    def get_today(self, code: str):
        return self._inner.get_today(self._venue, code)

    def store_today(self, code: str, bar: dict | None) -> None:
        self._inner.store_today(self._venue, code, bar)


def _candle_to_dict(c) -> dict:
    return {
        "t_ms": c.t_ms,
        "open": c.open,
        "high": c.high,
        "low": c.low,
        "close": c.close,
        "volume": c.volume,
    }


def _daily_fallback_to_krx_warning(primary_venue: KisVenue, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "daily_fallback_to_krx",
        "msg": (
            f"{primary_venue} daily returned no candles; using KRX daily candles "
            "for this batch"
        ),
    }


def _daily_partial_fallback_to_krx_warning(primary_venue: KisVenue, batch_label: str) -> dict:
    return {
        "batch": batch_label,
        "reason": "daily_fallback_to_krx",
        "msg": (
            f"{primary_venue} daily returned a partial range; filling missing daily "
            "candles from KRX for this batch"
        ),
    }


def _daily_candle_date(candle) -> date:
    return datetime.fromtimestamp(candle.t_ms / 1000, tz=_KST).date()


def _needs_krx_daily_fill(candles: list, from_s: str, to_s: str) -> bool:
    if not candles:
        return True
    from_d = datetime.strptime(from_s, "%Y%m%d").date()
    to_d = datetime.strptime(to_s, "%Y%m%d").date()
    dates = sorted({_daily_candle_date(c) for c in candles})
    # A few calendar days of edge slack avoids fallback for weekend/holiday
    # request edges. Month-scale holes (observed 089030 NXT/UN) must be filled.
    if dates[0] > from_d + timedelta(days=10):
        return True
    if dates[-1] < to_d - timedelta(days=10):
        return True
    return any((b - a).days > 10 for a, b in zip(dates, dates[1:]))


def _merge_daily_fallback(primary: list, fallback: list) -> list:
    by_ts = {c.t_ms: c for c in fallback}
    by_ts.update({c.t_ms: c for c in primary})
    return [by_ts[t] for t in sorted(by_ts)]
