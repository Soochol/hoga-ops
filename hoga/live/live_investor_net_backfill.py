from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date
from typing import Protocol

from hoga.live import kis_access
from hoga.live.kis_client import KisClient
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


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


class LiveInvestorNetBackfill:
    """Owns Live Investor Net scheduled fetch shape and row conversion."""

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

    async def collect(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
    ) -> dict:
        async def fetch_batch(code_: str, from_s: str, to_s: str):
            result = await kis_access.run_with_capacity(
                self._scheduler,
                data_dir=self._data_dir,
                key=("live-investor-net", code_, from_s, to_s),
                endpoint=kis_access.KisRestEndpoint.INVESTOR_NET,
                priority="background",
                cooldown_scope="investor-net",
                fetch_fn=lambda kis: kis.fetch_investor_net(code_, from_s, to_s),
            )
            return [_investor_point_to_dict(p) for p in result.points], result.violations

        return await self._walkback(
            cache=self._cache,
            fetch_batch=fetch_batch,
            output_key="points",
            code=code,
            frm=frm,
            too=too,
            today_d=today_d,
        )


def _investor_point_to_dict(p) -> dict:
    return {
        "t_ms": p.t_ms,
        "foreign_net": p.foreign_net,
        "institution_net": p.institution_net,
    }
