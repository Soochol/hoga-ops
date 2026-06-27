from __future__ import annotations

from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live.kis_client import KisClient
from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)
from hoga.live.live_rest_capture_access import ScheduledLiveRestCaptureClient


class _FakeKis:
    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        return KisOrderbook(
            code=code,
            asks=[OrderbookLevel(price=101, qty=10)],
            bids=[OrderbookLevel(price=100, qty=20)],
            total_ask_qty=10,
            total_bid_qty=20,
            t_ms=1770000000000,
        )

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        return [
            KisTrade(
                price=100,
                qty=3,
                side=1,
                side_source="inferred",
                t_ms=1770000000000,
            )
        ]

    async def fetch_brokers(self, code: str) -> KisBrokers:
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="미래", qty=7)],
            sell_top=[KisBrokerEntry(name="삼성", qty=5)],
        )


class _RecordingScheduler:
    def __init__(self) -> None:
        self.kis = _FakeKis()
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: str,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ):
        self.calls.append(
            {
                "key": key,
                "endpoint": endpoint,
                "priority": priority,
                "cooldown_scope": cooldown_scope,
            }
        )
        return await call(self.kis)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_scheduled_live_rest_capture_client_schedules_capture_calls(tmp_path) -> None:
    scheduler = _RecordingScheduler()
    client = ScheduledLiveRestCaptureClient(
        data_dir=tmp_path,
        scheduler=scheduler,  # type: ignore[arg-type]
        source="unit",
    )

    orderbook = await client.fetch_orderbook("005930")
    trades = await client.fetch_trades("005930")
    brokers = await client.fetch_brokers("005930")

    assert orderbook.code == "005930"
    assert trades[0].price == 100
    assert brokers.code == "005930"
    assert scheduler.calls == [
        {
            "key": ("unit", "orderbook", "005930"),
            "endpoint": "live-orderbook",
            "priority": "background",
            "cooldown_scope": "orderbook",
        },
        {
            "key": ("unit", "trades", "005930"),
            "endpoint": "live-trades",
            "priority": "background",
            "cooldown_scope": "trades",
        },
        {
            "key": ("unit", "brokers", "005930"),
            "endpoint": "live-brokers",
            "priority": "background",
            "cooldown_scope": "brokers",
        },
    ]
