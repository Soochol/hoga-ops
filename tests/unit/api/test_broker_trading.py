from __future__ import annotations

import asyncio
import json
import sqlite3
from datetime import datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from hoga.api.trading_routes import build_router as legacy_router
from hoga.api.trading_v2_routes import build_router
from hoga.live.kiwoom_budget import KiwoomBudget
from hoga.trading.accounts import AccountRegistry
from hoga.trading.contracts import BrokerCommand, CancelBrokerOrders, CreateBrokerOrder, ModifyBrokerOrder
from hoga.trading.kiwoom import KiwoomAccountGateway, KiwoomTradingAdapter
from hoga.trading.models import TossOrder
from hoga.trading.multi_broker import BrokerTradingService
from hoga.trading.service import TradingService
from hoga.trading.toss import TossClient, TradingError
from hoga.util.timeenc import KST

HEADERS = {"X-Hoga-Order": "1"}


class Provider:
    def __init__(self, environment="real", token="kiwoom-token"):
        self._creds = SimpleNamespace(environment=environment)
        self.token = token
        self.fail = False
        self.invalidated = 0

    def get_token(self):
        if self.fail:
            raise RuntimeError("SECRET-token-provider")
        return self.token

    def invalidate(self):
        self.invalidated += 1


def open_order(native="0000001", *, code="005930", quantity="100", remainder="70", route="KRX", side="BUY"):
    return {
        "ord_no": native,
        "stk_cd": code,
        "ord_qty": quantity,
        "oso_qty": remainder,
        "ord_pric": "67200",
        "ord_stt": "체결",
        "cntr_qty": "30",
        "cntr_tot_amt": "2016000",
        "io_tp_nm": "+매수" if side == "BUY" else "-매도",
        "trde_tp": "2" if side == "BUY" else "1",
        "stex_tp_txt": route,
        "sor_yn": "Y" if route == "SOR" else "N",
        "tm": "100000",
    }


class Kiwoom:
    def __init__(self, number="1111111111"):
        self.number = number
        self.requests = []
        self.writes = []
        self.opens = [open_order()]
        self.history = []
        self.ledger = []
        self.failure = ""
        self.capacity = "1000"
        self.next_id = 10
        self.block = None
        self.custom_response = None
        self.holdings_rows = None

    async def handle(self, request):  # noqa: PLR0912 — fake broker explicitly implements each pinned TR
        self.requests.append(request)
        api = request.headers["api-id"]
        body = json.loads(request.content)
        assert request.headers["authorization"] == "Bearer kiwoom-token"
        assert request.url.host in {"api.kiwoom.com", "mockapi.kiwoom.com"}
        if api == "ka00001":
            result = {"acctNo": self.number}
        elif api == "ka10075":
            result = {"oso": self.opens}
        elif api == "kt00007":
            result = {"acnt_ord_cntr_prps_dtl": self.history}
        elif api == "kt00015":
            result = {"trst_ovrl_trde_prps_array": self.ledger}
        elif api == "kt00018":
            result = {
                "acnt_evlt_remn_indv_tot": [
                    {
                        "stk_cd": "A005930",
                        "stk_nm": "삼성전자",
                        "rmnd_qty": "000000100",
                        "pur_pric": "000066000",
                        "trde_able_qty": "80",
                        "crd_tp": "00",
                    }
                ]
            }
            if self.holdings_rows is not None:
                result["acnt_evlt_remn_indv_tot"] = self.holdings_rows
        elif api == "kt00011":
            if self.capacity is None:
                return httpx.Response(200, json={"return_code": 20, "return_msg": "SECRET-account"})
            result = {"min_ord_alowq": self.capacity, "min_ord_alow_amt": "50000000", "profa_20ord_alowq": "999999999"}
        else:
            assert request.url.path == "/api/dostk/ordr"
            self.writes.append(request)
            native = f"{self.next_id:07}"
            self.next_id += 1
            if self.failure == "reject":
                return httpx.Response(200, json={"return_code": 20, "return_msg": "SECRET-account"})
            original = body.get("orig_ord_no")
            if api in {"kt10000", "kt10001"}:
                self.opens.append(
                    open_order(
                        native,
                        code=body["stk_cd"],
                        quantity=body["ord_qty"],
                        remainder=body["ord_qty"],
                        route=body["dmst_stex_tp"],
                        side="BUY" if api == "kt10000" else "SELL",
                    )
                )
            elif api in {"kt10002", "kt10003"}:
                self.opens = [o for o in self.opens if o["ord_no"] != original]
                if api == "kt10002":
                    self.opens.append(
                        open_order(
                            native, quantity=body["mdfy_qty"], remainder=body["mdfy_qty"], route=body["dmst_stex_tp"]
                        )
                    )
                self.history.append(
                    {
                        "ord_no": native,
                        "stk_cd": body["stk_cd"],
                        "ord_qty": "70",
                        "ord_remnq": "0",
                        "ord_uv": "67200",
                        "trde_tp": "매수",
                        "io_tp_nm": "매수정정" if api == "kt10002" else "매수취소",
                        "ori_ord": original,
                        "acpt_tp": "확인",
                        "cnfm_qty": "70",
                        "cntr_qty": "0",
                        "dmst_stex_tp": body["dmst_stex_tp"],
                    }
                )
            if self.block:
                await self.block.wait()
            if self.custom_response is not None:
                return self.custom_response
            if self.failure == "timeout":
                raise httpx.ReadTimeout("SECRET-response-lost")
            if self.failure == "server":
                return httpx.Response(503, json={"return_code": 0})
            if self.failure == "invalid":
                return httpx.Response(200, text="SECRET-bad-envelope")
            result = {"ord_no": "bad" if self.failure == "identity" else native}
            if original:
                result["base_orig_ord_no"] = "9999999" if self.failure == "original" else original
        return httpx.Response(200, json={"return_code": 0, **result})


@pytest.fixture
async def setup(tmp_path):
    registry = AccountRegistry(tmp_path / "trading/accounts.sqlite3")
    broker = Kiwoom()
    provider = Provider()
    gateway = KiwoomAccountGateway(
        provider, transport=httpx.MockTransport(broker.handle), budget=KiwoomBudget(interval=0)
    )
    adapter = KiwoomTradingAdapter(gateway, registry, tmp_path)
    legacy = TradingService(tmp_path)
    service = BrokerTradingService(tmp_path, legacy, kiwoom=[adapter])
    app = FastAPI()
    app.include_router(build_router(service))
    app.include_router(legacy_router(legacy))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
        await service.accounts()
        yield broker, provider, adapter, service, api
    await service.close()
    await legacy.close()


def create(ref, cid="create-1", **extra):
    return CreateBrokerOrder(
        account_ref=ref, command_id=cid, code="005930", side="BUY", quantity=10, price=67200, route="KRX", **extra
    )


async def test_create_routes_exact_fields_with_durable_dedup_and_restart(setup):
    broker, _, adapter, service, api = setup
    command = create(adapter.account_ref)
    first, second = await asyncio.gather(
        *[api.post("/api/trading/v2/orders", json=command.model_dump(), headers=HEADERS) for _ in range(2)]
    )
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert len(broker.writes) == 1
    assert json.loads(broker.writes[0].content) == {
        "dmst_stex_tp": "KRX",
        "stk_cd": "005930",
        "ord_qty": "10",
        "ord_uv": "67200",
        "trde_tp": "0",
    }
    restarted = BrokerTradingService(service.data_dir, service.legacy, kiwoom=[adapter])
    assert (await restarted.execute(command, "create")).model_dump() == first.json()
    assert len(broker.writes) == 1
    assert service.journal.lookup(command.command_id)[1] == "accepted"


async def test_modify_uses_explicit_current_remainder_and_original_route(setup):
    broker, _, adapter, service, _ = setup
    broker.opens[0]["oso_qty"] = "50"  # Synthetic 100 ordered / 30 filled / 20 cancelled.
    broker.opens[0]["sor_yn"] = "Y"
    state = await service.state(adapter.account_ref, "005930")
    order = state.orders[0]
    assert order.remaining_quantity == "50" and order.filled_quantity is None
    command = ModifyBrokerOrder(account_ref=adapter.account_ref, command_id="modify-1", code="005930", price=67100)
    result = await service.execute(command, "modify", order.order_ref)
    body = json.loads(broker.writes[0].content)
    assert body == {
        "dmst_stex_tp": "SOR",
        "stk_cd": "005930",
        "orig_ord_no": "0000001",
        "mdfy_qty": "50",
        "mdfy_uv": "67100",
    }
    assert result.order_ref == order.order_ref and result.operation_ref != order.order_ref


async def test_cancel_preserves_native_zero_prefix_and_keeps_operation_separate(setup):
    broker, _, adapter, service, api = setup
    state = await service.state(adapter.account_ref, "005930")
    order = state.orders[0]
    command = BrokerCommand(account_ref=adapter.account_ref, command_id="cancel-1", code="005930")
    forbidden = await api.post(f"/api/trading/v2/orders/{order.order_ref}/cancel", json=command.model_dump())
    assert forbidden.status_code == 403 and not broker.writes
    result = await service.execute(command, "cancel", order.order_ref)
    assert json.loads(broker.writes[0].content)["orig_ord_no"] == "0000001"
    assert json.loads(broker.writes[0].content)["cncl_qty"] == "70"
    assert result.operation_ref and result.order_ref == order.order_ref


@pytest.mark.parametrize("failure", ["timeout", "server", "invalid", "identity"])
async def test_lost_or_invalid_write_never_replays_after_restart(setup, failure):
    broker, _, adapter, service, _ = setup
    broker.failure = failure
    command = create(adapter.account_ref)
    with pytest.raises(TradingError, match="주문") as first:
        await service.execute(command, "create")
    assert first.value.code == "order-outcome-unknown"
    assert service.journal.lookup(command.command_id)[1] == "unknown"
    restarted = BrokerTradingService(service.data_dir, service.legacy, kiwoom=[adapter])
    with pytest.raises(TradingError) as second:
        await restarted.execute(command, "create")
    assert second.value.code == "order-outcome-unknown" and len(broker.writes) == 1
    with pytest.raises(TradingError) as fresh:
        await restarted.execute(create(adapter.account_ref, "different-id"), "create")
    assert fresh.value.code == "unresolved-order-exists" and len(broker.writes) == 1


async def test_explicit_business_rejection_is_durable_and_redacted(setup):
    broker, _, adapter, service, _ = setup
    broker.failure = "reject"
    for _ in range(2):
        with pytest.raises(TradingError) as error:
            await service.execute(create(adapter.account_ref), "create")
        assert error.value.code == "kiwoom-rejected-20"
        assert "SECRET" not in error.value.message
    assert len(broker.writes) == 1
    assert service.journal.lookup("create-1")[1] == "rejected"


@pytest.mark.parametrize("route", ["KRX", "NXT", "SOR"])
async def test_real_orders_are_enabled_without_acceptance_file(setup, route):
    broker, _, adapter, service, _ = setup
    account = await adapter.account()
    assert account.order_enabled and account.routes == ["KRX", "NXT", "SOR"]
    assert account.supported_routes == account.routes and account.blocked_reason is None
    assert not (adapter.data_dir / "trading/kiwoom-acceptance.json").exists()
    command = create(adapter.account_ref).model_copy(update={"route": route})
    await service.execute(command, "create")
    assert len(broker.writes) == 1
    assert json.loads(broker.writes[0].content)["dmst_stex_tp"] == route


async def test_direct_gateway_write_still_requires_durable_command_path(setup):
    broker, _, adapter, _, _ = setup
    with pytest.raises(TradingError) as error:
        await adapter.gateway.call("kt10000", {})
    assert error.value.code == "kiwoom-orders-disabled" and not broker.writes


@pytest.mark.parametrize("capacity", ["0", None])
async def test_cash_policy_never_uses_margin_capacity_or_unavailable_as_zero(setup, capacity):
    broker, _, adapter, service, _ = setup
    broker.capacity = capacity
    balances = await service.balances(adapter.account_ref, "005930", 67200)
    assert balances.buyable_quantity == capacity
    if capacity is None:
        assert balances.buying_power is None and balances.capacity_status == "unavailable"
    with pytest.raises(TradingError) as error:
        await service.execute(create(adapter.account_ref), "create")
    assert error.value.code == "order-capacity-unavailable" and not broker.writes


async def test_change_of_account_under_same_credential_never_rebinds(setup):
    broker, _, adapter, service, _ = setup
    old = adapter.account_ref
    broker.number = "2222222222"
    with pytest.raises(TradingError) as error:
        await service.execute(create(old), "create")
    assert error.value.code == "account-binding-changed" and not broker.writes
    assert adapter.account_ref == old


async def test_second_account_cannot_resolve_or_cancel_first_account_order(setup):
    broker, _, adapter, service, _ = setup
    first = (await service.state(adapter.account_ref, "005930")).orders[0]
    other_broker = Kiwoom("2222222222")
    other = KiwoomTradingAdapter(
        KiwoomAccountGateway(
            Provider(),
            account_index=1,
            transport=httpx.MockTransport(other_broker.handle),
            budget=KiwoomBudget(interval=0),
        ),
        service.registry,
        service.data_dir,
    )
    service._kiwoom.append(other)
    await service.accounts()
    assert other.account_ref != adapter.account_ref
    with pytest.raises(TradingError) as error:
        await service.execute(
            BrokerCommand(account_ref=other.account_ref, code="005930", command_id="cross"), "cancel", first.order_ref
        )
    assert error.value.code == "order-context-mismatch"
    assert not broker.writes and not other_broker.writes


async def test_stale_business_date_cannot_hit_reused_native_number(setup):
    broker, _, adapter, service, _ = setup
    yesterday = (datetime.now(KST) - timedelta(days=1)).strftime("%Y%m%d")
    old = service.registry.order_ref(adapter.account_ref, "0000001", yesterday, "KRX")
    with pytest.raises(TradingError) as error:
        await service.execute(
            BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="old-day"), "cancel", old
        )
    assert error.value.code == "order-date-mismatch" and not broker.writes


async def test_event_watermark_blocks_lagging_rest_and_foreign_events_are_ignored(setup):
    broker, _, adapter, service, _ = setup
    order = (await service.state(adapter.account_ref, "005930")).orders[0]
    adapter.account_event(
        {"type": "00", "values": {"9201": broker.number, "9203": "0000001", "902": "40", "913": "체결"}}, 2
    )
    command = ModifyBrokerOrder(account_ref=adapter.account_ref, code="005930", command_id="event-lag", price=67100)
    with pytest.raises(TradingError) as error:
        await service.execute(command, "modify", order.order_ref)
    assert error.value.code == "order-state-syncing" and not broker.writes
    broker.opens[0]["oso_qty"] = "40"
    adapter.account_event(
        {"type": "00", "values": {"9201": "9999999999", "9203": "0000001", "902": "0", "913": "취소"}}, 3
    )
    adapter.account_event(
        {"type": "00", "values": {"9201": broker.number, "9203": "0000001", "902": "0", "913": "취소"}}, 1
    )  # Older generation must not overwrite.
    await service.execute(command.model_copy(update={"command_id": "event-ready"}), "modify", order.order_ref)
    assert json.loads(broker.writes[0].content)["mdfy_qty"] == "40"


async def test_success_response_with_wrong_original_identity_stays_unknown(setup):
    broker, _, adapter, service, _ = setup
    order = (await service.state(adapter.account_ref, "005930")).orders[0]
    broker.failure = "original"
    with pytest.raises(TradingError) as error:
        await service.execute(
            BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="bad-original"),
            "cancel",
            order.order_ref,
        )
    assert error.value.code == "order-outcome-unknown" and len(broker.writes) == 1


async def test_persist_failure_after_acceptance_never_turns_into_another_write(setup, monkeypatch):
    broker, _, adapter, service, _ = setup
    finish = service.journal.finish

    def fail_accepted(cid, state, result):
        if state == "accepted":
            raise sqlite3.OperationalError("disk unavailable")
        finish(cid, state, result)

    monkeypatch.setattr(service.journal, "finish", fail_accepted)
    command = create(adapter.account_ref)
    for _ in range(2):
        with pytest.raises(TradingError) as error:
            await service.execute(command, "create")
        assert error.value.code == "order-outcome-unknown"
    assert len(broker.writes) == 1


async def test_bulk_freezes_targets_and_preserves_partial_unknowns(setup):
    broker, _, adapter, service, _ = setup
    broker.opens.append(open_order("0000002"))
    broker.failure = "timeout"
    command = CancelBrokerOrders(account_ref=adapter.account_ref, command_id="bulk", code="005930")
    result = await service.cancel_all(command)
    assert len(result["results"]) == 2 and len(broker.writes) == 2
    assert all(not item["accepted"] for item in result["results"])
    broker.opens.append(open_order("0000003"))
    assert await service.cancel_all(command) == result
    assert len(broker.writes) == 2


async def test_command_review_is_scoped_and_does_not_replay_unknown(setup):
    broker, _, adapter, service, api = setup
    broker.failure = "timeout"
    command = create(adapter.account_ref)
    with pytest.raises(TradingError):
        await service.execute(command, "create")
    status = await api.get(
        f"/api/trading/v2/commands/{command.command_id}", params={"account_ref": adapter.account_ref}
    )
    assert status.json()["state"] == "unknown"
    await service.review(command)
    assert service.unresolved(adapter.account_ref, "005930") == []
    assert service.journal.lookup(command.command_id)[2]["reviewed_at_ms"] > 0
    assert service.journal.lookup(command.command_id)[2]["code"] == "order-outcome-unknown"
    with pytest.raises(TradingError):
        await service.execute(command, "create")
    assert len(broker.writes) == 1


async def test_toss_legacy_and_v2_join_same_command_and_keep_unknown_history(tmp_path):
    from tests.unit.api.test_toss_trading import Broker  # Existing Toss wire contract fixture.

    broker = Broker()
    client = TossClient("id", "secret", transport=httpx.MockTransport(broker.handle))
    legacy = TradingService(tmp_path, client)
    legacy.start_events = lambda: None
    service = BrokerTradingService(tmp_path, legacy, kiwoom=[])
    app = FastAPI()
    app.include_router(legacy_router(legacy))
    app.include_router(build_router(service))
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as api:
        accounts = (await api.get("/api/trading/v2/accounts")).json()["accounts"]
        ref = accounts[0]["account_ref"]
        old = {
            "account_seq": 1,
            "command_id": "shared-create",
            "code": "005930",
            "side": "BUY",
            "price": 67200,
            "quantity": 10,
            "confirm_high_value": False,
        }
        new = {**{k: v for k, v in old.items() if k != "account_seq"}, "account_ref": ref, "route": "SOR"}
        a, b = await asyncio.gather(
            api.post("/api/trading/orders", json=old, headers=HEADERS),
            api.post("/api/trading/v2/orders", json=new, headers=HEADERS),
        )
        assert a.status_code == b.status_code == 200 and len(broker.posts) == 1
        broker.failure = "timeout"
        old["command_id"] = "legacy-unknown"
        assert (await api.post("/api/trading/orders", json=old, headers=HEADERS)).status_code == 503
        state = (
            await api.get("/api/trading/v2/state", params={"account_ref": ref, "code": "005930", "part": "orders"})
        ).json()
        assert state["unresolved_commands"] == ["legacy-unknown"]
        assert "account_seq" not in state
        # New display conversion failures cannot disrupt the existing event path.
        events = []
        service.on_event = events.append
        from tests.unit.api.test_toss_trading import order

        service.toss_order_event(1, TossOrder.model_validate({**order("bad-time"), "orderedAt": "invalid"}), 3)
        assert events[-1] == {"type": "trading_changed_v2", "account_ref": ref, "revision": 3}
        # A refreshed legacy alias must never silently move the v2 selection.
        legacy._accounts[0]["accountNo"] = "2222222222"
        with pytest.raises(TradingError) as error:
            await service.toss.authorize(ref)
        assert error.value.code == "account-binding-changed"
    await service.close()
    await legacy.close()


async def test_official_history_clock_and_duplicate_cash_holdings(setup):
    from decimal import ROUND_CEILING, Decimal

    broker, _, adapter, service, _ = setup
    # Pinned Kiwoom official kt00007 example uses a colon-delimited time.
    row = {
        "ord_no": "0000050",
        "stk_cd": "A069500",
        "trde_tp": "시장가",
        "ord_qty": "0000000001",
        "ord_uv": "0000000000",
        "cnfm_qty": "0000000000",
        "acpt_tp": "접수",
        "ord_tm": "13:05:43",
        "ori_ord": "0000000",
        "io_tp_nm": "현금매수",
        "cntr_qty": "0000000001",
        "ord_remnq": "0000000000",
        "dmst_stex_tp": "KRX",
    }
    order = adapter.parse_order(row, "20261019", history=True)
    assert order.ordered_at == "2026-10-19T13:05:43+09:00"
    assert order.status == "FILLED" and order.order_type == "MARKET"
    broker.holdings_rows = [
        {
            "stk_cd": "A005930",
            "stk_nm": "삼성전자",
            "rmnd_qty": "3",
            "pur_pric": "124500",
            "pur_amt": "373500",
            "trde_able_qty": "3",
            "crd_tp": "00",
        },
        {
            "stk_cd": "A005930",
            "stk_nm": "삼성전자",
            "rmnd_qty": "8",
            "pur_pric": "209178",
            "pur_amt": "1673430",
            "trde_able_qty": "8",
            "crd_tp": "00",
        },
        {"stk_cd": "A005930", "rmnd_qty": "99", "crd_tp": "03"},
    ]
    (holding,) = await adapter.holdings()
    assert holding["quantity"] == holding["sellable_quantity"] == "11"
    cost = Decimal(holding["average_purchase_price"]) * Decimal(holding["quantity"])
    assert cost.to_integral_value(rounding=ROUND_CEILING) == 2046930
    balance = await service.balances(adapter.account_ref, "005930")
    assert balance.holding_quantity == "11"


@pytest.mark.parametrize("vendor_code", [True, [], {}, "success", None])
async def test_malformed_acceptance_never_replays(setup, vendor_code):
    broker, _, adapter, service, _ = setup
    broker.custom_response = httpx.Response(200, json={"return_code": vendor_code, "ord_no": "0000010"})
    for _ in range(2):
        with pytest.raises(TradingError) as error:
            await service.execute(create(adapter.account_ref), "create")
        assert error.value.code == "order-outcome-unknown"
    assert len(broker.writes) == 1


async def test_auth_rejection_invalidates_next_request_without_replay(setup):
    broker, provider, adapter, service, _ = setup
    broker.custom_response = httpx.Response(401, json={"return_code": 8005, "return_msg": "SECRET"})
    for _ in range(2):
        with pytest.raises(TradingError) as error:
            await service.execute(create(adapter.account_ref), "create")
        assert error.value.code == "kiwoom-rejected-8005"
    assert provider.invalidated == 1 and len(broker.writes) == 1


async def test_canceled_waiter_does_not_cancel_or_duplicate_inflight_write(setup):
    broker, _, adapter, service, _ = setup
    broker.block = asyncio.Event()
    command = create(adapter.account_ref)
    waiter = asyncio.create_task(service.execute(command, "create"))
    for _ in range(1000):
        if broker.writes:
            break
        await asyncio.sleep(0)
    assert len(broker.writes) == 1
    waiter.cancel()
    with pytest.raises(asyncio.CancelledError):
        await waiter
    duplicate = asyncio.create_task(service.execute(command, "create"))
    broker.block.set()
    assert (await duplicate).status == "accepted"
    assert len(broker.writes) == 1


async def test_queue_expiry_and_event_during_admission_never_send(setup, monkeypatch):
    broker, _, adapter, service, _ = setup
    order = (await adapter.order_state("005930")).orders[0]

    async def expired(api_id, *, write=False, deadline=None):
        if write:
            raise TimeoutError("queue-expired")

    monkeypatch.setattr(adapter.gateway.budget, "acquire", expired)
    with pytest.raises(TradingError) as error:
        await service.execute(create(adapter.account_ref), "create")
    assert error.value.code == "order-queue-expired"
    assert service.journal.lookup("create-1")[1] == "rejected" and broker.writes == []

    async def event_during_queue(api_id, *, write=False, deadline=None):
        if write:
            adapter.account_event(
                {"type": "00", "values": {"9201": broker.number, "9203": "0000001", "902": "0", "913": "취소"}}, 1
            )

    monkeypatch.setattr(adapter.gateway.budget, "acquire", event_during_queue)
    with pytest.raises(TradingError) as error:
        await service.execute(
            BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="late-event"),
            "cancel",
            order.order_ref,
        )
    assert error.value.code == "order-state-syncing" and broker.writes == []


async def test_incomplete_pagination_rejects_entire_snapshot(setup, monkeypatch):
    _, _, adapter, _, _ = setup
    calls = []

    async def page(api_id, body, *, cursor=""):
        calls.append(cursor)
        return {"oso": [open_order()]}, "repeated"

    monkeypatch.setattr(adapter.gateway, "call", page)
    with pytest.raises(TradingError):
        await adapter.gateway.rows("ka10075", {}, "oso")
    assert calls == ["", "repeated"]


async def test_unknown_status_and_market_modify_are_blocked(setup):
    broker, _, adapter, service, _ = setup
    row = open_order()
    row["ord_stt"] = "새로운상태"
    assert not adapter.parse_order(row, "20261019").editable
    assert not adapter.parse_order({**open_order(), "crd_tp": "03"}, "20261019").editable
    broker.opens[0]["trde_tp"] = "시장가"
    order = (await adapter.order_state("005930", fresh=True)).orders[0]
    with pytest.raises(TradingError) as error:
        await service.execute(
            ModifyBrokerOrder(account_ref=adapter.account_ref, code="005930", command_id="market", price=67000),
            "modify",
            order.order_ref,
        )
    assert error.value.code == "unsupported-order-type" and broker.writes == []


async def test_legacy_acceptance_file_does_not_block_supported_routes(setup):
    _, _, adapter, _, _ = setup
    path = adapter.data_dir / "trading/kiwoom-acceptance.json"
    for content in ('{', json.dumps({"accounts": {adapter.account_ref: {"routes": []}}})):
        path.write_text(content)
        assert (await adapter.account()).order_enabled
        assert adapter.routes() == ["KRX", "NXT", "SOR"]


async def test_mock_gateway_rejects_real_provider_and_uses_only_mock_host(tmp_path):
    with pytest.raises(ValueError, match="environment mismatch"):
        KiwoomAccountGateway(Provider(), environment="mock")
    broker = Kiwoom()
    gateway = KiwoomAccountGateway(
        Provider("mock"),
        environment="mock",
        transport=httpx.MockTransport(broker.handle),
        budget=KiwoomBudget(interval=0),
    )
    adapter = KiwoomTradingAdapter(
        gateway, AccountRegistry(tmp_path / "accounts.sqlite3"), tmp_path
    )
    try:
        account = await adapter.account()
        assert account.environment == "mock" and account.routes == ["KRX"]
        assert account.order_enabled and account.supported_routes == ["KRX"]
        assert broker.requests[0].url.host == "mockapi.kiwoom.com"
    finally:
        await gateway.close()


async def test_repeated_modify_preserves_root_across_immediate_parent_responses(setup):
    _, _, adapter, service, _ = setup
    target = (await adapter.order_state("005930")).orders[0]
    first = await service.execute(
        ModifyBrokerOrder(account_ref=adapter.account_ref, command_id="modify-first", code="005930", price=67100),
        "modify",
        target.order_ref,
    )
    replacement = next(
        o for o in (await adapter.order_state("005930", fresh=True)).orders if o.order_ref == first.operation_ref
    )
    assert replacement.root_order_id == target.broker_order_id
    second = await service.execute(
        ModifyBrokerOrder(account_ref=adapter.account_ref, command_id="modify-second", code="005930", price=67000),
        "modify",
        replacement.order_ref,
    )
    newest = next(
        o for o in (await adapter.order_state("005930", fresh=True)).orders if o.order_ref == second.operation_ref
    )
    assert newest.root_order_id == target.broker_order_id


async def test_v2_write_header_and_account_query_validation_precede_broker_io(setup):
    broker, _, adapter, _, api = setup
    before = len(broker.requests)
    response = await api.post("/api/trading/v2/orders", json=create(adapter.account_ref).model_dump())
    assert response.status_code == 403 and response.json()["detail"]["code"] == "order-header-required"
    response = await api.get("/api/trading/v2/state", params={"account_ref": "unverified", "code": "005930"})
    assert response.status_code == 422
    assert len(broker.requests) == before and broker.writes == []


async def test_post_ack_reference_conflict_stays_unknown_and_cannot_be_replayed(setup):
    broker, _, adapter, service, _ = setup
    date = datetime.now(KST).strftime("%Y%m%d")
    service.registry.order_ref(adapter.account_ref, "0000010", date, "SOR")
    for _ in range(2):
        with pytest.raises(TradingError) as error:
            await service.execute(create(adapter.account_ref), "create")
        assert error.value.code == "order-outcome-unknown"
    assert len(broker.writes) == 1 and service.unresolved(adapter.account_ref, "005930") == ["create-1"]


async def test_execution_history_preserves_partial_cancelled_fill_and_does_not_invent_time_or_average(setup):
    broker, _, adapter, _, api = setup
    broker.history = [{
        "ord_no": "0000042", "stk_cd": "A007810", "stk_nm": "코리아써키트",
        "ord_qty": "100", "ord_uv": "80500", "cntr_qty": "30", "cntr_uv": "80400",
        "ord_remnq": "0", "io_tp_nm": "매수", "trde_tp": "2", "acpt_tp": "확인",
        "ord_tm": "100000", "cnfm_tm": "100030", "dmst_stex_tp": "SOR",
    }]
    response = await api.get('/api/trading/v2/execution-history', params={
        'account_ref': adapter.account_ref, 'date': '20261028',
    })
    assert response.status_code == 200, response.text
    data = response.json()
    row = data['rows'][0]
    assert row['quantity'] == '30' and row['order_quantity'] == '100'
    assert row['price'] == '80400' and row['price_basis'] == 'execution'
    assert row['filled_at'] is None and row['amount'] is None
    assert row['route'] == 'SOR' and row['name'] == '코리아써키트'
    assert data['account_ref'] == adapter.account_ref and data['date'] == '20261028'
    reads = [r for r in broker.requests if r.headers['api-id'] == 'kt00007']
    assert json.loads(reads[-1].content)['dmst_stex_tp'] == '%'
    assert not broker.writes


async def test_execution_history_rejects_foreign_account_and_invalid_date_before_fetch(setup):
    broker, _, adapter, _, api = setup
    for params, status in [
        ({'account_ref': 'acc_' + 'f' * 32, 'date': '20261028'}, 403),
        ({'account_ref': adapter.account_ref, 'date': '20260230'}, 422),
        ({'account_ref': adapter.account_ref, 'date': '20261028', 'next_key': 'bad'}, 422),
    ]:
        response = await api.get('/api/trading/v2/execution-history', params=params)
        assert response.status_code == status, response.text
    assert not [r for r in broker.requests if r.headers['api-id'] == 'kt00007']


async def test_recent_year_stocks_use_ledger_period_read_through_the_pinned_gateway_without_writes(setup):
    broker, _, adapter, _, api = setup
    broker.ledger = [{'stk_cd': 'A0099A0', 'stk_nm': '과거 종목', 'cntr_dt': '20251101',
        'trde_dt': '20251103', 'proc_tm': '10:30:00', 'trde_ocr_tp': '9', 'trde_prtc_tp': '11',
        'crnc_cd': 'KRW', 'trde_qty_jwa_cnt': '10'}]
    response = await api.get('/api/trading/v2/execution-history-range', params={
        'account_ref': adapter.account_ref, 'from_date': '20251028', 'to_date': '20261028'})
    assert response.status_code == 200, response.text
    assert response.json()['rows'] == [{'code': '0099A0', 'name': '과거 종목', 'date': '20251101', 'filled_at': None}]
    reads = [request for request in broker.requests if request.headers['api-id'] == 'kt00015']
    assert len(reads) == 1
    assert json.loads(reads[0].content) == {'strt_dt': '20251028', 'end_dt': '20261028',
        'tp': '3', 'stk_cd': '', 'crnc_cd': 'KRW', 'gds_tp': '1', 'frgn_stex_code': '',
        'dmst_stex_tp': '%', 'qry_sort_tp': '1'}
    assert not broker.writes


async def test_execution_history_pages_are_account_bound_and_preserve_modified_order_fills(setup, monkeypatch):
    _, _, adapter, _, api = setup
    original = adapter.gateway.call
    seen = []

    async def call(api_id, body, **kwargs):
        if api_id != 'kt00007':
            return await original(api_id, body, **kwargs)
        seen.append((body, kwargs.get('cursor')))
        native = '0000051' if not kwargs.get('cursor') else '0000052'
        row = {'ord_no': native, 'stk_cd': 'A007810', 'ord_qty': '100', 'ord_uv': '80500',
               'cntr_qty': '20', 'cntr_uv': '80500', 'ord_remnq': '80',
               'io_tp_nm': '매수정정', 'trde_tp': '2', 'acpt_tp': '체결',
               'ori_ord': '0000040', 'dmst_stex_tp': 'SOR', 'ord_tm': '100000'}
        return {'acnt_ord_cntr_prps_dtl': [row, row]}, 'opaque-next' if not kwargs.get('cursor') else None

    monkeypatch.setattr(adapter.gateway, 'call', call)
    params = {'account_ref': adapter.account_ref, 'date': '20261028'}
    first = (await api.get('/api/trading/v2/execution-history', params=params)).json()
    assert len(first['rows']) == 1 and first['rows'][0]['quantity'] == '20'
    second = (await api.get('/api/trading/v2/execution-history',
                            params={**params, 'next_key': first['next_key']})).json()
    assert second['next_key'] is None
    assert first['rows'][0]['order_ref'] != second['rows'][0]['order_ref']
    assert seen[0][1] == '' and seen[1][1] == 'opaque-next'
    assert all(body['dmst_stex_tp'] == '%' for body, _ in seen)
