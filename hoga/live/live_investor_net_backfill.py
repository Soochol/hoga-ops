from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from datetime import date
from typing import Protocol

from hoga.live import kiwoom_access, kiwoom_investor, kiwoom_rest_runtime
from hoga.live.kiwoom_capacity import Priority
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache
from hoga.live.single_flight import SingleFlight


class KiwoomRestScheduler(Protocol):
    """거버너 계약. PR-E(#1041)로 키움을 쓰면서 **계정 차원이 사라졌다** —
    `endpoint`/`cooldown_scope` 대신 `api_id` 가 버킷 키다(#1015)."""

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: Priority,
        call: Callable[[], Awaitable],
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
        scheduler: KiwoomRestScheduler,
        walkback: Walkback,
    ) -> None:
        self._data_dir = data_dir
        self._cache = cache
        self._scheduler = scheduler
        self._walkback = walkback
        # Coalesce concurrent same-code cold walk-backs (see single_flight.py):
        # overlapping [from, today] requests share one KIS fetch instead of each
        # walking the background lane independently (the 60–100s storm).
        self._inflight = SingleFlight()

    async def collect(
        self,
        *,
        code: str,
        frm: date,
        too: date,
        today_d: date,
    ) -> dict:
        async def fetch_batch(code_: str, from_s: str, to_s: str):
            # PR-E(#1041) 칼 컷오버 — 소스는 키움 ka10059 다. 계정 차원(cooldown_scope·
            # data_dir)은 사라졌다: 키움 유량은 TR별이라 고를 계정이 없다(#1015).
            client = kiwoom_rest_runtime.ensure_rest_client(self._data_dir)
            if client is None:
                return [], []
            result = await kiwoom_access.run_with_capacity(
                self._scheduler,   # 주입된 거버너 — 테스트가 갈아끼우는 이음매다
                key=("live-investor-net", code_, from_s, to_s),
                api_id="ka10059",
                priority="background",
                client=client,
                fetch_fn=lambda c: kiwoom_investor.fetch_investor_net(
                    c, code_, from_s, to_s
                ),
            )
            return [_investor_point_to_dict(p) for p in result.points], result.violations

        async with self._inflight.acquire(code):
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
