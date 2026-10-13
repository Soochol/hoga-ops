from __future__ import annotations

import asyncio
import time
from datetime import datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_routes import build_paper_router
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind
from hoga.trading.models import (
    CancelTradingOrders,
    CreateTradingOrder,
    ModifyTradingOrder,
    ResetPaperAccount,
    TradingCommand,
)
from hoga.trading.paper import KST, PaperTradingService
from hoga.trading.toss import TossClient, TradingError

CODE = "005930"


def command(cid: str, code: str = CODE) -> dict:
    return {"account_seq": 1, "command_id": cid, "code": code}


def buy(cid: str, price: int = 100, qty: int = 50, code: str = CODE) -> CreateTradingOrder:
    return CreateTradingOrder(**command(cid, code), side="BUY", price=price, quantity=qty)


class Feed:
    def __init__(self) -> None:
        self.buffer = LiveBuffer()
        self.at = int(time.time() * 1000)

    async def publish(self, qty: int = 30, ask: int = 100, bid: int = 99, code: str = CODE, delta: int = 1):
        self.at += delta
        await self.buffer.publish(
            code,
            [
                LiveSnapshot(
                    self.at,
                    SnapshotKind.OB,
                    {
                        "venue": "UN",
                        "asks": [{"price": ask, "qty": qty}, {"price": ask + 1, "qty": 100}],
                        "bids": [{"price": bid, "qty": 20}, {"price": bid - 1, "qty": 100}],
                    },
                )
            ],
        )

    async def book(self, code: str) -> dict | None:
        return await self.buffer.get_last_ob(code, "UN")


@pytest.fixture
async def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    feed = Feed()
    await feed.publish()
    service = PaperTradingService(tmp_path, feed.book)
    monkeypatch.setattr(service, "start", lambda: None)
    # Even with real-mode configuration present, paper routes must never hit Toss.
    monkeypatch.setenv("TOSSINVEST_CLIENT_ID", "test-id")
    monkeypatch.setenv("TOSSINVEST_CLIENT_SECRET", "test-secret")

    async def forbidden(*args, **kwargs):
        pytest.fail("paper trading called the real broker")

    monkeypatch.setattr(TossClient, "request", forbidden)
    app = FastAPI()
    app.include_router(build_paper_router(service))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app), base_url="http://test", headers={"X-Hoga-Order": "1"}
    ) as api:
        yield service, feed, api
    await service.close()


async def reset(service: PaperTradingService, qty: int = 0, cash: int = 10000):
    return await service.reset(
        ResetPaperAccount(
            **command("reset"), cash=cash, holding_quantity=qty, average_purchase_price=90, confirmed=True
        )
    )


async def snapshot(service: PaperTradingService):
    return await service.state(1, CODE)


async def test_http_real_buffer_partial_fill_and_cash_reservation(setup):
    service, feed, api = setup
    accounts = (await api.get("/api/paper-trading/accounts")).json()
    assert accounts == {"configured": True, "accounts": [{"account_seq": 1, "label": "로컬 모의 계좌"}]}
    await reset(service)
    response = await api.post("/api/paper-trading/orders", json=buy("buy").model_dump())
    assert response.status_code == 200
    state = (await api.get("/api/paper-trading/state", params={"account_seq": 1, "code": CODE})).json()
    assert state["orders"][0]["execution"]["filledQuantity"] == "30"
    assert state["orders"][0]["status"] == "PARTIAL_FILLED"
    assert state["holding_quantity"] == "30"
    assert state["buying_power"] == "5000"  # 3,000 spent + 2,000 reserved.
    assert state["sellable_quantity"] == "30"
    # Neither repeated reads nor a fresh but unchanged book can reuse liquidity.
    await feed.publish()
    assert (await snapshot(service)).orders[0].execution.filledQuantity == "30"
    await feed.publish(qty=40)
    assert (await snapshot(service)).orders[0].execution.filledQuantity == "40"
    await feed.publish(qty=50)
    state = await snapshot(service)
    assert not state.orders
    assert state.recent_orders[0].status == "FILLED"
    assert state.holding_quantity == "50" and state.buying_power == "5000"


async def test_modify_current_remainder_and_cancel_release_reserved_cash(setup):
    service, _, api = setup
    await reset(service)
    old = await service.execute(buy("buy"), "create")
    response = await api.post(f"/api/paper-trading/orders/{old.order_id}/modify", json={**command("move"), "price": 99})
    assert response.status_code == 200
    state = await snapshot(service)
    assert state.orders[0].quantity == "20" and state.orders[0].price == "99"
    assert state.orders[0].execution.filledQuantity == "0"
    assert state.recent_orders[0].execution.filledQuantity == "30"
    assert state.holding_quantity == "30" and state.buying_power == "5020"
    new_id = response.json()["order_id"]
    assert new_id != old.order_id
    await service.execute(TradingCommand(**command("cancel")), "cancel", new_id)
    state = await snapshot(service)
    assert not state.orders and state.buying_power == "7000"
    with pytest.raises(TradingError, match="종료"):
        await service.execute(TradingCommand(**command("cancel-again")), "cancel", new_id)


async def test_sell_partial_updates_holdings_and_prevents_overselling(setup):
    service, _, _ = setup
    await reset(service, qty=50)
    order = await service.execute(CreateTradingOrder(**command("sell"), side="SELL", price=99, quantity=40), "create")
    state = await snapshot(service)
    assert state.holding_quantity == "30" and state.sellable_quantity == "10"
    assert state.buying_power == "11980" and state.orders[0].execution.filledQuantity == "20"
    with pytest.raises(TradingError, match="매도 가능"):
        await service.execute(CreateTradingOrder(**command("over-sell"), side="SELL", price=100, quantity=11), "create")
    await service.execute(TradingCommand(**command("cancel")), "cancel", order.order_id)
    assert (await snapshot(service)).sellable_quantity == "30"


async def test_shared_liquidity_price_time_priority_and_multiple_levels(setup):
    service, feed, _ = setup
    # Resting orders then a new, marketable book: better limit first, FIFO on ties.
    await feed.publish(ask=110, bid=90)
    await service.execute(buy("early", price=100, qty=20), "create")
    await service.execute(buy("better", price=101, qty=20), "create")
    await service.execute(buy("later", price=100, qty=20), "create")
    await feed.publish(qty=30, ask=100, bid=99)
    state = await snapshot(service)
    by_id = {o.orderId: o for o in state.orders + state.recent_orders}
    assert by_id["paper-2"].execution.filledQuantity == "20"
    assert by_id["paper-1"].execution.filledQuantity == "10"
    assert by_id["paper-3"].execution.filledQuantity == "0"
    await service.cancel_all(CancelTradingOrders(**command("clear")))
    await service.execute(buy("sweep", price=101, qty=15), "create")
    state = await snapshot(service)
    assert state.recent_orders[0].execution.filledAmount == "1515"  # only remaining level 101.


async def test_freshness_missing_crossed_future_and_cancel_stale(setup):
    service, feed, api = setup
    old = await service.execute(buy("rest", price=99), "create")
    feed.at = int(time.time() * 1000) - 60000
    await feed.publish()
    denied = await api.post("/api/paper-trading/orders", json=buy("stale").model_dump())
    assert denied.status_code == 409
    assert denied.json()["detail"]["code"] == "paper-book-stale"
    await service.execute(TradingCommand(**command("cancel")), "cancel", old.order_id)
    assert not (await snapshot(service)).orders
    feed.at = int(time.time() * 1000)
    await feed.publish(ask=100, bid=100)
    with pytest.raises(TradingError, match="양방향"):
        await service.execute(buy("crossed"), "create")
    with pytest.raises(TradingError, match="오래"):
        await service.execute(buy("no-feed", code="000660"), "create")
    feed.at += 60000
    await feed.publish()
    with pytest.raises(TradingError, match="오래"):
        await service.execute(buy("future"), "create")


async def test_global_cash_reservations_concurrency_and_failed_modify_rollback(setup):
    service, feed, _ = setup
    await reset(service, cash=1000)
    await feed.publish(code="000660")
    results = await asyncio.gather(
        service.execute(buy("a", price=99, qty=10), "create"),
        service.execute(buy("b", price=99, qty=10, code="000660"), "create"),
        return_exceptions=True,
    )
    assert sum(isinstance(result, TradingError) for result in results) == 1
    winner = next(r for r in results if not isinstance(r, Exception))
    winner_code = next(o["symbol"] for o in service.doc["orders"] if o["orderId"] == winner.order_id)
    with pytest.raises(TradingError, match="금액"):
        await service.execute(
            ModifyTradingOrder(**command("increase", winner_code), price=200, quantity=10), "modify", winner.order_id
        )
    state = await service.state(1, winner_code)
    assert state.orders[0].price == "99" and state.buying_power == "10"


async def test_durable_retry_and_bulk_scope_does_not_cancel_later_orders(setup, tmp_path):
    service, feed, _ = setup
    first = await service.execute(buy("a", price=99), "create")
    await service.execute(buy("b", price=98), "create")
    await feed.publish(code="000660")
    await service.execute(buy("other-code", price=99, code="000660"), "create")
    bulk = CancelTradingOrders(**command("bulk"))
    result = await service.cancel_all(bulk)
    assert len(result.results) == 2
    later = await service.execute(buy("later", price=97), "create")
    restarted = PaperTradingService(tmp_path, feed.book)
    restarted.start = lambda: None
    assert await restarted.execute(buy("a", price=99), "create") == first
    assert await restarted.cancel_all(bulk) == result
    state = await restarted.state(1, CODE)
    assert [o.orderId for o in state.orders] == [later.order_id]
    assert len((await restarted.state(1, "000660")).orders) == 1
    with pytest.raises(TradingError, match="식별자"):
        await restarted.execute(buy("a", price=98), "create")


async def test_reset_confirmation_header_and_account_context(setup):
    service, _, api = setup
    body = {**command("init"), "cash": 12345, "holding_quantity": 100, "average_purchase_price": 90, "confirmed": True}
    denied = await api.post("/api/paper-trading/reset", json={**body, "confirmed": False})
    assert denied.status_code == 422
    missing = await api.post("/api/paper-trading/reset", json=body, headers={"X-Hoga-Order": ""})
    assert missing.status_code == 403
    result = await api.post("/api/paper-trading/reset", json=body)
    assert result.status_code == 200
    assert result.json()["holding_quantity"] == "100" and result.json()["buying_power"] == "12345"
    assert result.json()["average_purchase_price"] == "90"
    await service.execute(buy("before-reset", price=99, qty=1), "create")
    await reset(service)
    await service.execute(buy("before-reset", price=99, qty=1), "create")
    assert not (await snapshot(service)).orders  # Late command retries cannot resurrect a cleared account.
    denied = await api.get("/api/paper-trading/state", params={"account_seq": 2, "code": CODE})
    assert denied.status_code == 403


async def test_background_reconcile_and_next_day_expiry(tmp_path):
    feed = Feed()
    await feed.publish(ask=110, bid=90)
    changed = asyncio.Event()
    service = PaperTradingService(tmp_path, feed.book, on_change=lambda _: changed.set())
    try:
        await service.execute(buy("pending", qty=50), "create")
        changed.clear()
        await feed.publish(ask=100, bid=99)
        await asyncio.wait_for(changed.wait(), timeout=3)
        # Read the committed document directly; no state request to trigger fills.
        assert service.doc["orders"][0]["execution"]["filledQuantity"] == "30"
        doc = service._load()
        doc["orders"][0]["orderedAt"] = (datetime.now(KST) - timedelta(days=1)).isoformat()
        service._save(doc)
        state = await snapshot(service)
        assert not state.orders and state.recent_orders[0].status == "EXPIRED"
        assert state.holding_quantity == "30"
    finally:
        await service.close()


async def test_price_improvement_multiple_levels_and_restart_preserves_consumed_depth(setup, tmp_path):
    service, feed, _ = setup
    await reset(service)
    await service.execute(buy("sweep-levels", price=101, qty=35), "create")
    state = await snapshot(service)
    filled = state.recent_orders[0]
    assert filled.execution.filledQuantity == "35"
    assert filled.execution.filledAmount == "3505"
    assert state.buying_power == "6495" and state.holding_quantity == "35"
    restarted = PaperTradingService(tmp_path, feed.book)
    restarted.start = lambda: None
    await restarted.execute(buy("cannot-reuse", price=100, qty=10), "create")
    state = await snapshot(restarted)
    assert state.orders[0].execution.filledQuantity == "0"
    assert state.holding_quantity == "35"
    await feed.publish(qty=35)
    state = await snapshot(restarted)
    assert state.orders[0].execution.filledQuantity == "5"
    assert state.holding_quantity == "40"
