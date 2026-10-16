from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_routes import build_router
from hoga.trading.models import CancelTradingOrders, CreateTradingOrder, ModifyTradingOrder, TradingCommand
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
        self.requests: list[httpx.Request] = []
        self.posts: list[httpx.Request] = []
        self.open: list[dict] = []
        self.detail = order()
        self.failure = ""
        self.tokens = 0
        self.market = "KOSPI"
        self.currency = "KRW"

    async def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
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
            if self.failure in {"rejected", "opposite"}:
                error = {
                    "code": "opposite-pending-order-exists",
                    "message": "동일 종목에 반대 방향의 체결 대기 주문이 있습니다.",
                } if self.failure == "opposite" else {"code": "already-filled", "message": "이미 체결됨"}
                return httpx.Response(409, json={"error": error})
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


@pytest.mark.parametrize("side,pending_side", [("BUY", "SELL"), ("SELL", "BUY")])
@pytest.mark.parametrize("price", [67100, 67200, 67300])
async def test_opposite_pending_order_is_submitted_to_broker(setup, side, pending_side, price):
    broker, _, api = setup
    broker.open = [order(side=pending_side)]
    body = {
        "account_seq": 1, "code": "005930", "command_id": "opposite",
        "price": price, "quantity": 10, "side": side,
    }
    response = await api.post("/api/trading/orders", json=body, headers={"X-Hoga-Order": "1"})
    assert response.status_code == 200
    assert response.json()["status"] == "accepted"
    assert len(broker.posts) == 1
    assert broker.posts[0].url.path == "/api/v1/orders"
    payload = json.loads(broker.posts[0].content)
    assert payload["side"] == side and payload["price"] == str(price)
    # No preflight OPEN lookup or implicit cancellation of the existing order.
    assert not any(r.method == "GET" and r.url.path == "/api/v1/orders" for r in broker.requests)


async def test_broker_opposite_rejection_is_preserved_and_not_replayed(setup):
    broker, service, api = setup
    broker.open = [order(side="SELL")]
    broker.failure = "opposite"
    body = {
        "account_seq": 1, "code": "005930", "command_id": "opposite-rejected",
        "price": 67200, "quantity": 10, "side": "BUY",
    }
    for _ in range(2):
        response = await api.post("/api/trading/orders", json=body, headers={"X-Hoga-Order": "1"})
        assert response.status_code == 409
        assert response.json()["detail"] == {
            "code": "opposite-pending-order-exists",
            "message": "동일 종목에 반대 방향의 체결 대기 주문이 있습니다.",
        }
    assert len(broker.posts) == 1
    assert service.journal.unresolved(1, "005930") == []


async def test_foreign_account_symbol_and_high_value_block_before_write(setup):
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


async def test_twenty_bulk_cancels_overlap_with_one_fresh_list_and_no_detail_reads(setup):
    broker, service, api = setup
    broker.open = [order(str(i)) for i in range(20)]
    # A cached display snapshot must not determine the targets.
    await service.order_state(1, "005930")
    broker.open.append(order("latest"))
    broker.requests.clear()
    entered, release = asyncio.Event(), asyncio.Event()
    started: list[str] = []
    original = broker.handle

    async def delayed(request):
        if request.method == "POST":
            started.append(request.url.path)
            if len(started) == 10:
                entered.set()
            await release.wait()
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(delayed))
    body = {"account_seq": 1, "code": "005930", "command_id": "fast-bulk"}
    task = asyncio.create_task(api.post("/api/trading/cancel-all", json=body, headers={"X-Hoga-Order": "1"}))
    concurrent = None
    try:
        await asyncio.wait_for(entered.wait(), 3)
        assert len(started) == 10  # Multiple requests sent before ANY response, bounded in flight.
        assert not task.done()
        concurrent = asyncio.create_task(api.post(
            "/api/trading/cancel-all", json=body, headers={"X-Hoga-Order": "1"},
        ))
        await asyncio.sleep(0)
    finally:
        release.set()
        response = await task
        duplicate = await concurrent if concurrent else None
    assert response.status_code == 200
    assert duplicate.json() == response.json()
    assert [r["order_id"] for r in response.json()["results"]] == [str(i) for i in range(20)] + ["latest"]
    assert all(r["accepted"] for r in response.json()["results"])
    reads = [r for r in broker.requests if r.method == "GET"]
    assert [(r.url.path, dict(r.url.params)) for r in reads] == [
        ("/api/v1/orders", {"status": "OPEN", "symbol": "005930"}),
    ]
    assert len(broker.posts) == len(set(started)) == 21
    again = await api.post("/api/trading/cancel-all", json=body, headers={"X-Hoga-Order": "1"})
    assert again.json() == response.json()
    assert len(broker.posts) == 21


@pytest.mark.parametrize("other_action", ["bulk", "cancel", "modify"])
async def test_overlapping_bulk_and_other_commands_never_send_two_changes_to_one_order(
    setup, monkeypatch, other_action,
):
    broker, service, _ = setup
    broker.open = [order()]
    entered, registered, release = asyncio.Event(), asyncio.Event(), asyncio.Event()
    original = broker.handle
    begin = service.journal.begin
    child_ids: set[str] = set()

    def record_begin(command_id, payload):
        result = begin(command_id, payload)
        if payload["order_id"] == "old":
            child_ids.add(command_id)
            if len(child_ids) == 2:
                registered.set()
        return result

    monkeypatch.setattr(service.journal, "begin", record_begin)

    async def delayed(request):
        if request.method == "POST" and request.url.path.startswith("/api/v1/orders/"):
            entered.set()
            await release.wait()
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(delayed))
    first = asyncio.create_task(service.cancel_all(
        CancelTradingOrders(account_seq=1, code="005930", command_id="first"),
    ))
    second = None
    try:
        await asyncio.wait_for(entered.wait(), 3)
        if other_action == "bulk":
            operation = service.cancel_all(CancelTradingOrders(account_seq=1, code="005930", command_id="second"))
        else:
            command = (
                ModifyTradingOrder(account_seq=1, code="005930", command_id="second", price=67000)
                if other_action == "modify" else TradingCommand(account_seq=1, code="005930", command_id="second")
            )
            operation = service.execute(command, other_action, "old")
        second = asyncio.create_task(operation)
        await asyncio.wait_for(registered.wait(), 3)
    finally:
        release.set()
        first_result = await first
        second_result = (await asyncio.gather(second, return_exceptions=True))[0] if second else None
    assert first_result.results[0].accepted
    if other_action == "bulk":
        assert second_result.results[0].code == "order-processing"
    else:
        assert isinstance(second_result, TradingError)
        assert second_result.code == "order-processing"
    assert len(broker.posts) == 1


@pytest.mark.parametrize("failure", ["", "timeout"])
async def test_bulk_cancel_restart_different_request_id_never_repeats_accepted_or_unknown_write(setup, failure):
    broker, service, _ = setup
    broker.open = [order()]
    broker.failure = failure
    first = await service.cancel_all(CancelTradingOrders(account_seq=1, code="005930", command_id="before-restart"))
    assert first.results[0].accepted == (not failure)
    restarted = TradingService(service.journal.path.parents[1], service.client)
    try:
        second = await restarted.cancel_all(
            CancelTradingOrders(account_seq=1, code="005930", command_id="after-restart"),
        )
        assert not second.results[0].accepted
        assert second.results[0].code == ("unresolved-order-exists" if failure else "order-processing")
    finally:
        await restarted.close()
    assert len(broker.posts) == 1


async def test_bulk_restart_keeps_frozen_targets_and_uses_fresh_status(setup):
    broker, service, _ = setup
    command = CancelTradingOrders(account_seq=1, code="005930", command_id="interrupted-batch")
    service.journal.begin(command.command_id, {**command.model_dump(), "action": "bulk", "order_id": ""})
    service.journal.finish(command.command_id, "batch", {"targets": [{"id": "old", "status": "PARTIAL_FILLED"}]})
    broker.open = [order(status="PENDING_CANCEL"), order("created-later")]
    result = await service.cancel_all(command)
    assert [r.order_id for r in result.results] == ["old"]
    assert result.results[0].code == "order-not-editable"
    assert not broker.posts


async def test_interrupted_bulk_resumes_only_unsent_targets_and_keeps_child_results(setup):
    broker, service, _ = setup
    command = CancelTradingOrders(account_seq=1, code="005930", command_id="partial-batch")
    service.journal.begin(command.command_id, {**command.model_dump(), "action": "bulk", "order_id": ""})
    service.journal.finish(command.command_id, "batch", {
        "targets": [{"id": oid, "status": "PARTIAL_FILLED"} for oid in ("accepted", "unknown", "unsent")],
    })
    for oid in ("accepted", "unknown"):
        child = TradingCommand(
            account_seq=1, code="005930",
            command_id=str(uuid.uuid5(uuid.NAMESPACE_URL, f"{command.command_id}:{oid}")),
        )
        broker.failure = "timeout" if oid == "unknown" else ""
        try:
            await service.execute(child, "cancel", oid)
        except TradingError as error:
            assert error.code == "order-outcome-unknown"
    broker.failure = ""
    broker.open = [order(oid) for oid in ("accepted", "unknown", "unsent", "created-later")]
    restarted = TradingService(service.journal.path.parents[1], service.client)
    try:
        result = await restarted.cancel_all(command)
        assert [r.order_id for r in result.results] == ["accepted", "unknown", "unsent"]
        assert [r.accepted for r in result.results] == [True, False, True]
        assert result.results[1].code == "order-outcome-unknown"
        assert await restarted.cancel_all(command) == result
    finally:
        await restarted.close()
    assert [r.url.path for r in broker.posts] == [
        f"/api/v1/orders/{oid}/cancel" for oid in ("accepted", "unknown", "unsent")
    ]


@pytest.mark.parametrize("kind", ["foreign", "terminal-event", "zero-remainder", "duplicate"])
async def test_bulk_snapshot_preserves_context_and_order_guards(setup, kind):
    broker, service, _ = setup
    await service.authorize(1)
    broker.open = [order()]
    if kind == "foreign":
        broker.open = [order(code="000660")]
    elif kind == "terminal-event":
        service.order_event({
            "topic": "personal:order:1", "data": {"accountSeq": "1", "order": order(status="CANCELED")},
        })
    elif kind == "zero-remainder":
        broker.open = [order(filled="100")]
    else:
        broker.open *= 2
    result = await service.cancel_all(CancelTradingOrders(account_seq=1, code="005930", command_id="guarded-bulk"))
    assert len(result.results) == 1
    assert result.results[0].accepted == (kind == "duplicate")
    assert len(broker.posts) == (1 if kind == "duplicate" else 0)


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


async def test_account_orders_returns_all_domestic_symbols_and_keeps_symbol_snapshots_separate(setup):
    broker, service, api = setup
    broker.open = [order(f"kr-{i}", code="005930" if i % 2 else "000660") for i in range(130)]
    broker.open.append({**order("us", code="ABCDEF"), "currency": "USD"})
    seen = []
    original = broker.handle

    async def handle(request):
        if request.url.path == "/api/v1/orders":
            seen.append(dict(request.url.params))
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(handle))
    response = await api.get("/api/trading/account-orders?account_seq=1")
    assert response.status_code == 200
    assert len(response.json()["orders"]) == 130
    assert {o["symbol"] for o in response.json()["orders"]} == {"005930", "000660"}
    assert seen[0] == {"status": "OPEN"}
    assert seen[1] == {"status": "CLOSED", "limit": "100"}
    await api.get("/api/trading/account-orders?account_seq=1")
    assert len(seen) == 2  # Shared account snapshot, no extra broker read.
    await api.get("/api/trading/state?account_seq=1&code=005930&part=orders")
    assert len(seen) == 4 and seen[2]["symbol"] == "005930"
    forbidden = await api.get("/api/trading/account-orders?account_seq=2")
    assert forbidden.status_code == 403
    assert len(broker.posts) == 0


async def test_account_holdings_filters_domestic_positive_positions_and_reuses_cache(setup):
    broker, service, api = setup
    original = broker.handle
    reads = 0

    async def handle(request):
        nonlocal reads
        if request.url.path == "/api/v1/holdings":
            reads += 1
            base = {"symbol": "000660", "name": "SK하이닉스", "marketCountry": "KR", "currency": "KRW",
                    "quantity": "22", "averagePurchasePrice": "180000.5"}
            return httpx.Response(200, json={"result": {"items": [base, {**base, "quantity": "0"},
                {**base, "marketCountry": "US", "currency": "USD", "symbol": "AAPL"}]}})
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(handle))
    response = await api.get("/api/trading/holdings?account_seq=1")
    assert response.status_code == 200
    assert response.json()["holdings"] == [{
        "code": "000660", "name": "SK하이닉스", "quantity": "22", "average_purchase_price": "180000.5",
    }]
    await api.get("/api/trading/holdings?account_seq=1")
    assert reads == 1
    service.changed()
    await api.get("/api/trading/holdings?account_seq=1")
    assert reads == 2
    assert (await api.get("/api/trading/holdings?account_seq=2")).status_code == 403
    assert len(broker.posts) == 0


async def test_account_list_cancel_uses_target_symbol_and_latest_validation_with_dedup(setup):
    broker, _service, api = setup
    broker.detail = order("target", filled="80", code="000660", side="SELL")
    body = {"account_seq": 1, "code": "000660", "command_id": "account-list-cancel"}
    responses = await asyncio.gather(*[api.post("/api/trading/orders/target/cancel", json=body,
        headers={"X-Hoga-Order": "1"}) for _ in range(2)])
    assert all(response.status_code == 200 for response in responses)
    assert len(broker.posts) == 1
    assert broker.posts[0].url.path == "/api/v1/orders/target/cancel"


async def test_incomplete_account_order_response_is_not_presented_as_a_full_list(setup):
    broker, service, api = setup
    original = broker.handle

    async def handle(request):
        if request.url.path == "/api/v1/orders" and request.url.params["status"] == "OPEN":
            return httpx.Response(200, json={"result": {"orders": [order()], "hasNext": True, "nextCursor": "next"}})
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(handle))
    response = await api.get("/api/trading/account-orders?account_seq=1")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "invalid-toss-response"
    assert not service._snapshots


async def test_invalid_holding_quantity_is_reported_instead_of_silently_hidden(setup):
    broker, service, api = setup
    original = broker.handle

    async def handle(request):
        if request.url.path == "/api/v1/holdings":
            return httpx.Response(200, json={"result": {"items": [{
                "symbol": "005930", "name": "삼성전자", "marketCountry": "KR", "currency": "KRW",
                "quantity": "NaN", "averagePurchasePrice": "67200",
            }]}})
        return await original(request)

    await service.client.http.aclose()
    service.client.http = httpx.AsyncClient(base_url=TossClient.BASE_URL, transport=httpx.MockTransport(handle))
    response = await api.get("/api/trading/holdings?account_seq=1")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "invalid-toss-response"
