from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_routes import build_router
from hoga.trading.models import CreateTradingOrder, ModifyTradingOrder, TradingCommand
from hoga.trading.service import TradingService
from hoga.trading.toss import TossClient, TradingError


def order(
    order_id: str = "old",
    *,
    filled: str = "30",
    status: str = "PARTIAL_FILLED",
    code: str = "005930",
    side: str = "BUY",
) -> dict:
    return {
        "orderId": order_id,
        "symbol": code,
        "side": side,
        "orderType": "LIMIT",
        "timeInForce": "DAY",
        "status": status,
        "price": "67200",
        "quantity": "100",
        "currency": "KRW",
        "orderedAt": "2026-10-13T10:00:00+09:00",
        "execution": {"filledQuantity": filled},
    }


class Broker:
    def __init__(self) -> None:
        self.posts: list[httpx.Request] = []
        self.open: list[dict] = []
        self.detail = order()
        self.failure = ""
        self.tokens = 0
        self.market = "KOSPI"
        self.currency = "KRW"

    async def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/oauth2/token":
            self.tokens += 1
            assert b"grant_type=client_credentials" in request.content
            return httpx.Response(200, json={"access_token": "test-token", "expires_in": 86400})
        assert request.headers["Authorization"] == "Bearer test-token"
        if path == "/api/v1/accounts":
            assert "X-Tossinvest-Account" not in request.headers
            return httpx.Response(
                200, json={"result": [{"accountNo": "12345678901", "accountSeq": 1, "accountType": "BROKERAGE"}]}
            )
        if path == "/api/v1/stocks":
            return httpx.Response(
                200,
                json={
                    "result": [
                        {"symbol": request.url.params["symbols"], "market": self.market, "currency": self.currency}
                    ]
                },
            )
        assert request.headers["X-Tossinvest-Account"] == "1"
        if request.method == "POST":
            self.posts.append(request)
            if self.failure == "timeout":
                raise httpx.ReadTimeout("test only", request=request)
            if self.failure == "rejected":
                return httpx.Response(409, json={"error": {"code": "already-filled", "message": "이미 체결됨"}})
            return httpx.Response(200, json={"result": {"orderId": "successor"}})
        if path == "/api/v1/orders":
            return httpx.Response(
                200,
                json={
                    "result": {
                        "orders": self.open if request.url.params["status"] == "OPEN" else [],
                        "nextCursor": None,
                        "hasNext": False,
                    }
                },
            )
        responses = {
            "/api/v1/buying-power": {"cashBuyingPower": "20000000"},
            "/api/v1/sellable-quantity": {"sellableQuantity": "100"},
            "/api/v1/holdings": {"items": [{"symbol": "005930", "quantity": "100", "averagePurchasePrice": "66000"}]},
        }
        if path in responses:
            return httpx.Response(200, json={"result": responses[path]})
        return httpx.Response(200, json={"result": {**self.detail, "orderId": path.rsplit("/", 1)[-1]}})


@pytest.fixture
async def setup(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    broker = Broker()
    client = TossClient("test-id", "test-secret", transport=httpx.MockTransport(broker.handle))
    service = TradingService(tmp_path, client)
    monkeypatch.setattr(service, "start_events", lambda: None)
    monkeypatch.setattr(client, "_pace", lambda *args: asyncio.sleep(0))
    app = FastAPI()
    app.include_router(build_router(service))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app), base_url="http://test") as api:
        yield broker, service, api
    await service.close()


async def test_domestic_create_exact_payload_and_durable_dedup(setup):
    broker, service, api = setup
    body = {
        "account_seq": 1,
        "command_id": "new-1",
        "code": "005930",
        "side": "BUY",
        "price": 67200,
        "quantity": 10,
        "confirm_high_value": False,
    }
    a, b = await asyncio.gather(
        *[api.post("/api/trading/orders", json=body, headers={"X-Hoga-Order": "1"}) for _ in range(2)]
    )
    assert a.status_code == b.status_code == 200
    assert a.json() == b.json() == {"command_id": "new-1", "order_id": "successor", "status": "accepted"}
    assert len(broker.posts) == 1
    assert json.loads(broker.posts[0].content) == {
        "clientOrderId": "new-1",
        "symbol": "005930",
        "side": "BUY",
        "orderType": "LIMIT",
        "timeInForce": "DAY",
        "quantity": "10",
        "price": "67200",
        "confirmHighValueOrder": False,
    }
    # The persisted request survives a service/process restart.
    restarted = TradingService(service.journal.path.parents[1], service.client)
    result = await restarted.execute(CreateTradingOrder(**body), "create")
    assert result.order_id == "successor"
    assert len(broker.posts) == 1
    changed = {**body, "quantity": 11}
    response = await api.post("/api/trading/orders", json=changed, headers={"X-Hoga-Order": "1"})
    assert response.status_code == 409


async def test_modify_fetches_latest_remainder_and_returns_new_identity(setup):
    broker, _, api = setup
    broker.detail = order(filled="40")  # Another 10 shares filled during drag.
    response = await api.post(
        "/api/trading/orders/old/modify",
        json={
            "account_seq": 1,
            "command_id": "edit-1",
            "code": "005930",
            "price": 67100,
        },
        headers={"X-Hoga-Order": "1"},
    )
    assert response.status_code == 200
    assert response.json()["order_id"] == "successor"
    assert json.loads(broker.posts[0].content)["quantity"] == "60"
    assert broker.posts[0].url.path == "/api/v1/orders/old/modify"


async def test_unknown_write_never_replays_or_turns_into_new_order(setup):
    broker, service, _ = setup
    broker.failure = "timeout"
    request = CreateTradingOrder(
        account_seq=1, code="005930", command_id="uncertain", side="BUY", quantity=10, price=67200
    )
    with pytest.raises(TradingError, match="결과"):
        await service.execute(request, "create")
    with pytest.raises(TradingError):
        await service.execute(request, "create")
    assert len(broker.posts) == 1
    assert service.journal.unresolved(1, "005930") == ["uncertain"]
    broker.failure = ""
    with pytest.raises(TradingError) as error:
        await service.execute(request.model_copy(update={"command_id": "different"}), "create")
    assert error.value.code == "unresolved-order-exists"
    assert len(broker.posts) == 1


async def test_foreign_account_symbol_opposite_and_high_value_block_before_write(setup):
    broker, service, api = setup
    broker.detail = order(code="000660")
    with pytest.raises(TradingError):
        await service.execute(
            ModifyTradingOrder(account_seq=1, code="005930", command_id="wrong-stock", price=67000), "modify", "old"
        )
    response = await api.post(
        "/api/trading/orders",
        json={
            "account_seq": 2,
            "code": "005930",
            "command_id": "wrong-account",
            "price": 67200,
            "quantity": 10,
            "side": "BUY",
        },
        headers={"X-Hoga-Order": "1"},
    )
    assert response.status_code == 403
    broker.open = [order(side="SELL")]
    with pytest.raises(TradingError) as opposite:
        await service.execute(
            CreateTradingOrder(
                account_seq=1, code="005930", command_id="opposite", price=67200, quantity=10, side="BUY"
            ),
            "create",
        )
    assert opposite.value.code == "opposite-pending-order-exists"
    broker.open = []
    with pytest.raises(TradingError) as high:
        await service.execute(
            CreateTradingOrder(
                account_seq=1, code="005930", command_id="high", price=100000, quantity=1000, side="BUY"
            ),
            "create",
        )
    assert high.value.code == "confirm-high-value-required"
    assert broker.posts == []


async def test_masked_accounts_and_snapshot_wire_fields(setup):
    broker, _, api = setup
    broker.open = [order()]
    accounts = await api.get("/api/trading/accounts")
    assert accounts.json() == {"configured": True, "accounts": [{"account_seq": 1, "label": "토스증권 · ****8901"}]}
    assert "test-secret" not in accounts.text and "12345678901" not in accounts.text
    response = await api.get("/api/trading/state?account_seq=1&code=005930")
    assert response.status_code == 200
    assert response.json()["orders"][0]["execution"]["filledQuantity"] == "30"
    assert response.json()["buying_power"] == "20000000"
    assert response.json()["unresolved_commands"] == []
    assert broker.tokens == 1


async def test_cancel_requires_header_and_has_empty_body(setup):
    broker, _, api = setup
    body = {"account_seq": 1, "code": "005930", "command_id": "cancel-1"}
    blocked = await api.post("/api/trading/orders/old/cancel", json=body)
    assert blocked.status_code == 403 and not broker.posts
    response = await api.post("/api/trading/orders/old/cancel", json=body, headers={"X-Hoga-Order": "1"})
    assert response.status_code == 200
    assert json.loads(broker.posts[0].content) == {}


async def test_closed_or_unknown_status_is_not_editable(setup):
    broker, service, _ = setup
    for index, status in enumerate(["FILLED", "PENDING_CANCEL", "NEW_VENDOR_STATUS"]):
        broker.detail = order(status=status)
        with pytest.raises(TradingError):
            await service.execute(
                TradingCommand(account_seq=1, code="005930", command_id=f"terminal-{index}"), "cancel", "old"
            )
    assert not broker.posts


async def test_bulk_cancel_records_partial_failures_and_never_crosses_side(setup):
    broker, _, api = setup
    broker.open = [order("a"), order("b", side="SELL"), order("c", status="PENDING_REPLACE")]
    broker.failure = "rejected"
    response = await api.post(
        "/api/trading/cancel-all",
        headers={"X-Hoga-Order": "1"},
        json={
            "account_seq": 1,
            "code": "005930",
            "command_id": "bulk-1",
            "side": "BUY",
        },
    )
    assert response.status_code == 200
    assert [r["order_id"] for r in response.json()["results"]] == ["a", "c"]
    assert not any(r["accepted"] for r in response.json()["results"])
    assert len(broker.posts) == 1


async def test_unknown_operation_on_same_order_is_blocked_until_explicit_review(setup):
    broker, service, api = setup
    broker.failure = "timeout"
    command = ModifyTradingOrder(account_seq=1, code="005930", command_id="lost-modify", price=67000)
    with pytest.raises(TradingError):
        await service.execute(command, "modify", "old")
    with pytest.raises(TradingError) as blocked:
        await service.execute(TradingCommand(account_seq=1, code="005930", command_id="new-cancel"), "cancel", "old")
    assert blocked.value.code == "unresolved-order-exists"
    assert len(broker.posts) == 1
    body = {"account_seq": 1, "code": "005930", "command_id": "lost-modify", "confirmed": False}
    rejected = await api.post("/api/trading/commands/lost-modify/review", json=body, headers={"X-Hoga-Order": "1"})
    assert rejected.status_code == 422
    reviewed = await api.post(
        "/api/trading/commands/lost-modify/review", json={**body, "confirmed": True}, headers={"X-Hoga-Order": "1"}
    )
    assert reviewed.status_code == 200
    assert not service.journal.unresolved(1, "005930")
    assert len(broker.posts) == 1  # Reviewing a record never sends an order.


async def test_accepted_operation_blocks_second_change_before_broker_snapshot_catches_up(setup):
    broker, service, _ = setup
    a = ModifyTradingOrder(account_seq=1, code="005930", command_id="modify-a", price=67000)
    await service.execute(a, "modify", "old")
    with pytest.raises(TradingError) as processing:
        await service.execute(a.model_copy(update={"command_id": "modify-b"}), "modify", "old")
    assert processing.value.code == "order-processing"
    assert len(broker.posts) == 1


async def test_order_events_use_account_declaration_and_invalidate_on_reconnect(setup, monkeypatch):
    _, service, _ = setup
    await service.authorize(1)
    arrived = asyncio.Event()
    revisions: list[int] = []

    def changed(revision: int) -> None:
        revisions.append(revision)
        if len(revisions) >= 2:
            arrived.set()

    service.on_change = changed

    class Socket:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def send(self, declaration):
            assert json.loads(declaration) == [{"type": "personal:order", "codes": ["1"]}]

        async def frames(self):
            yield json.dumps({"type": "subscriptions", "subscribed": ["personal:order:1"], "rejected": []})
            yield json.dumps({"type": "message", "topic": "personal:order:1", "data": {}})
            await asyncio.Event().wait()

        def __aiter__(self):
            return self.frames()

    def connect_fake(url, **kwargs):
        assert url == TossClient.WS_URL
        assert kwargs["additional_headers"] == {"Authorization": "Bearer test-token"}
        assert kwargs["ping_interval"] == 60
        return Socket()

    monkeypatch.setattr("hoga.trading.service.connect", connect_fake)
    service._events_task = asyncio.create_task(service._events_loop())
    await asyncio.wait_for(arrived.wait(), 2)
    assert service.events_connected
    assert revisions[:2] == [1, 2]


async def test_concurrent_distinct_new_orders_are_serialized_not_misclassified_unknown(setup):
    broker, service, _ = setup
    a = CreateTradingOrder(account_seq=1, code="005930", command_id="parallel-a", price=67200, quantity=10, side="BUY")
    b = a.model_copy(update={"command_id": "parallel-b"})
    results = await asyncio.gather(service.execute(a, "create"), service.execute(b, "create"))
    assert len(broker.posts) == 2
    assert {r.command_id for r in results} == {"parallel-a", "parallel-b"}


async def test_retried_bulk_cancel_never_includes_orders_created_after_original_request(setup):
    broker, _, api = setup
    broker.open = [order("a")]
    body = {"account_seq": 1, "code": "005930", "command_id": "frozen-bulk", "side": "BUY"}
    first = await api.post("/api/trading/cancel-all", json=body, headers={"X-Hoga-Order": "1"})
    assert first.status_code == 200
    broker.open = [order("later")]
    again = await api.post("/api/trading/cancel-all", json=body, headers={"X-Hoga-Order": "1"})
    assert again.json() == first.json()
    assert len(broker.posts) == 1
    assert first.json()["results"][0]["order_id"] == "a"


async def test_stock_info_uses_official_market_and_currency_fields_and_rejects_us(setup):
    broker, service, _ = setup
    broker.market, broker.currency = "NASDAQ", "USD"
    command = CreateTradingOrder(
        account_seq=1, code="ABCDEF", command_id="us-blocked", price=100, quantity=1, side="BUY"
    )
    with pytest.raises(TradingError) as error:
        await service.execute(command, "create")
    assert error.value.code == "unsupported-market"
    assert broker.posts == []


async def test_orders_part_does_not_wait_for_balances(setup, monkeypatch):
    broker, service, api = setup
    broker.open = [order(filled="40")]
    entered, release = asyncio.Event(), asyncio.Event()
    original = service.holdings

    async def slow_holdings(account):
        entered.set()
        await release.wait()
        return await original(account)

    monkeypatch.setattr(service, "holdings", slow_holdings)
    balances = asyncio.create_task(api.get("/api/trading/state?account_seq=1&code=005930&part=balances"))
    try:
        await asyncio.wait_for(entered.wait(), 1)
        response = await asyncio.wait_for(api.get("/api/trading/state?account_seq=1&code=005930&part=orders"), 1)
        assert response.status_code == 200
        assert response.json()["orders"][0]["execution"]["filledQuantity"] == "40"
        assert "buying_power" not in response.json()
        assert not balances.done()
    finally:
        release.set()
        result = await balances
    assert result.status_code == 200
    assert result.json()["buying_power"] == "20000000"
    assert "orders" not in result.json()


async def test_split_snapshots_cannot_hide_fills_from_modify_validation(setup):
    broker, service, _ = setup
    broker.open = [order(filled="30")]
    assert (await service.order_state(1, "005930")).orders[0].execution.filledQuantity == "30"
    broker.detail = order(filled="55")
    await service.execute(
        ModifyTradingOrder(account_seq=1, code="005930", command_id="fresh-split", price=67100), "modify", "old"
    )
    assert json.loads(broker.posts[0].content)["quantity"] == "45"
    with pytest.raises(TradingError) as blocked:
        await service.execute(
            TradingCommand(account_seq=1, code="005930", command_id="duplicate-split"), "cancel", "old"
        )
    assert blocked.value.code == "order-processing"
    assert len(broker.posts) == 1


async def test_valid_order_event_publishes_display_snapshot_without_rest(setup):
    broker, service, _ = setup
    await service.authorize(1)
    messages = []
    service.on_order_change = lambda account, snapshot, revision: messages.append((account, snapshot, revision))
    service.order_event({"topic": "personal:order:1", "data": {"accountSeq": "1", "order": order(filled="50")}})
    assert len(messages) == 1
    assert messages[0][0] == 1
    assert messages[0][1].execution.filledQuantity == "50"
    assert messages[0][2] == service.revision
    assert broker.posts == []


async def test_event_cannot_replace_fresh_rest_validation_or_allow_stale_remainder(setup):
    broker, service, _ = setup
    await service.authorize(1)
    service.order_event({"topic": "personal:order:1", "data": {"accountSeq": "1", "order": order(filled="50")}})
    broker.detail = order(filled="30")
    command = ModifyTradingOrder(account_seq=1, code="005930", command_id="stale-rest", price=67000)
    with pytest.raises(TradingError) as lag:
        await service.execute(command, "modify", "old")
    assert lag.value.code == "order-state-syncing"
    assert broker.posts == []
    broker.detail = order(filled="60")
    await service.execute(command.model_copy(update={"command_id": "fresh-rest"}), "modify", "old")
    assert json.loads(broker.posts[0].content)["quantity"] == "40"
    await service.execute(command.model_copy(update={"command_id": "fresh-rest"}), "modify", "old")
    assert len(broker.posts) == 1


async def test_terminal_event_and_foreign_account_are_not_usable_as_open_order(setup):
    broker, service, _ = setup
    await service.authorize(1)
    messages = []
    service.on_order_change = lambda *args: messages.append(args)
    service.order_event({"topic": "personal:order:2", "data": {"accountSeq": "2", "order": order()}})
    assert messages == []
    service.order_event({"topic": "personal:order:1", "data": {"accountSeq": "1", "order": order(status="CANCELED")}})
    service.order_event({"topic": "personal:order:1", "data": {"accountSeq": "1", "order": order()}})
    with pytest.raises(TradingError) as lag:
        await service.execute(TradingCommand(account_seq=1, code="005930", command_id="late-open"), "cancel", "old")
    assert lag.value.code == "order-state-syncing"
    assert broker.posts == []
