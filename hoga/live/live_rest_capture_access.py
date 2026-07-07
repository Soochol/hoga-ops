from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable
from pathlib import Path
from typing import Protocol

from hoga.live import kis_access
from hoga.live.kis_client import KisClient


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


class ScheduledLiveRestCaptureClient:
    """KisClient-shaped proxy for REST capture pollers backed by the scheduler."""

    def __init__(
        self,
        *,
        data_dir: Path,
        scheduler: KisRestScheduler,
        source: str,
    ) -> None:
        self._data_dir = data_dir
        self._scheduler = scheduler
        self._source = source

    async def fetch_orderbook(self, code: str):
        return await kis_access.run_with_capacity(
            self._scheduler,
            data_dir=self._data_dir,
            key=(self._source, "orderbook", code),
            endpoint=kis_access.KisRestEndpoint.LIVE_ORDERBOOK,
            priority="background",
            cooldown_scope="orderbook",
            fetch_fn=lambda kis: kis.fetch_orderbook(code),
        )

    async def fetch_trades(self, code: str):
        return await kis_access.run_with_capacity(
            self._scheduler,
            data_dir=self._data_dir,
            key=(self._source, "trades", code),
            endpoint=kis_access.KisRestEndpoint.LIVE_TRADES,
            priority="background",
            cooldown_scope="trades",
            fetch_fn=lambda kis: kis.fetch_trades(code),
        )

    async def fetch_brokers(self, code: str):
        return await kis_access.run_with_capacity(
            self._scheduler,
            data_dir=self._data_dir,
            key=(self._source, "brokers", code),
            endpoint=kis_access.KisRestEndpoint.LIVE_BROKERS,
            priority="background",
            cooldown_scope="brokers",
            fetch_fn=lambda kis: kis.fetch_brokers(code),
        )
