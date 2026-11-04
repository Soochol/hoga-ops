"""Kiwoom amendment identity and concurrency at the real command/gateway boundary."""

from __future__ import annotations

import asyncio
import json
import time
from collections import Counter
from types import SimpleNamespace

import httpx
import pytest

from hoga.live.kiwoom_budget import KiwoomBudget
from hoga.trading import kiwoom, kiwoom_admission, multi_broker
from hoga.trading.accounts import AccountRegistry
from hoga.trading.contracts import BrokerCommand, CancelBrokerOrders, CreateBrokerOrder, ModifyBrokerOrder
from hoga.trading.kiwoom import KiwoomAccountGateway, KiwoomTradingAdapter
from hoga.trading.multi_broker import BrokerTradingService
from hoga.trading.service import TradingService
from hoga.trading.toss import TradingError
from tests.unit.api.test_broker_trading import Kiwoom, Provider, open_order, setup as broker_setup

setup = broker_setup


def modification(adapter, command_id):
    return ModifyBrokerOrder(account_ref=adapter.account_ref, command_id=command_id, code="005930", price=67100)


@pytest.mark.parametrize("action", ["modify", "cancel"])
async def test_confirmed_success_does_not_reauthorize_stale_editable_original(setup, action):
    broker, _, adapter, service, _ = setup
    target = (await adapter.order_state("005930", fresh=True)).orders[0]
    command = (
        modification(adapter, "first")
        if action == "modify"
        else BrokerCommand(account_ref=adapter.account_ref, command_id="first", code="005930")
    )
    await service.execute(command, action, target.order_ref)
    # Deliberately contradictory vendor snapshot, not a live duplicate-acceptance claim.
    broker.opens = [open_order()]
    with pytest.raises(TradingError) as error:
        await service.execute(modification(adapter, "stale-original"), "modify", target.order_ref)
    assert error.value.code == "order-processing"
    assert len(broker.writes) == 1
    assert service.journal.lookup("stale-original")[1] == "rejected"


@pytest.mark.parametrize("action", ["modify", "cancel"])
async def test_later_canonical_rejection_allows_fresh_original_retry(setup, action):
    broker, _, adapter, service, _ = setup
    target = (await adapter.order_state("005930", fresh=True)).orders[0]
    command = (
        modification(adapter, "first")
        if action == "modify"
        else BrokerCommand(account_ref=adapter.account_ref, command_id="first", code="005930")
    )
    await service.execute(command, action, target.order_ref)
    broker.opens = [open_order()]
    broker.history[-1]["acpt_tp"] = "거부"
    result = await service.execute(modification(adapter, "canonical-retry"), "modify", target.order_ref)
    assert result.operation_ref and len(broker.writes) == 2


async def test_ack_without_canonical_effect_blocks_old_but_does_not_retire_it(setup):
    broker, _, adapter, service, _ = setup
    target = (await adapter.order_state("005930", fresh=True)).orders[0]
    await service.execute(modification(adapter, "ack-only"), "modify", target.order_ref)
    broker.opens = [open_order()]
    broker.history[-1].update(acpt_tp="접수", cnfm_qty="0")
    with pytest.raises(TradingError) as error:
        await service.execute(modification(adapter, "pending-operation"), "modify", target.order_ref)
    assert error.value.code == "order-processing" and len(broker.writes) == 1
    broker.history[-1]["acpt_tp"] = "거부"
    await service.execute(modification(adapter, "after-rejection"), "modify", target.order_ref)
    assert len(broker.writes) == 2


class WriteBarrier:
    def __init__(self, broker, adapter):
        self.gates = {}
        self.pending = self.peak = 0
        self.draining = False
        self.lost = set()
        self.calls = []
        original = broker.handle

        async def handle(request):
            write = request.headers["api-id"].startswith("kt1000")
            if not write:
                return await original(request)
            body = json.loads(request.content)
            key = body.get("orig_ord_no", "create")
            self.calls.append((request.headers["api-id"], key))
            self.pending += 1
            self.peak = max(self.peak, self.pending)
            try:
                response = await original(request)  # Effect becomes visible before the held ACK.
                gate = self.gates.setdefault(key, asyncio.Event())
                if not self.draining:
                    await gate.wait()
                if key in self.lost:
                    raise httpx.ReadTimeout("synthetic lost ACK", request=request)
                return response
            finally:
                self.pending -= 1

        adapter.gateway.http._transport = httpx.MockTransport(handle)

    def release(self, native):
        self.gates[native].set()

    def drain(self):
        self.draining = True
        for gate in self.gates.values():
            gate.set()


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0)


async def settle():
    for _ in range(50):
        await asyncio.sleep(0)


async def outcome(awaitable):
    try:
        return await awaitable
    except TradingError as error:
        return error.code


async def targets(broker, adapter, count=10, different_codes=False):
    broker.next_id = 1000
    broker.opens = [
        open_order(f"{i + 1:07}", code=f"{5930 + i:06}" if different_codes else "005930") for i in range(count)
    ]
    orders = (await adapter.order_state(fresh=True)).orders
    assert len({o.order_ref for o in orders}) == count
    return orders


@pytest.mark.parametrize("different_codes", [False, True])
async def test_independent_real_orders_share_owner_two_and_keep_every_fresh_read(setup, different_codes):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, different_codes=different_codes)
    barrier = WriteBarrier(broker, adapter)
    broker.requests.clear()
    tasks = [
        asyncio.create_task(
            service.execute(
                modification(adapter, f"independent-{i}").model_copy(update={"code": order.code}),
                "modify",
                order.order_ref,
            )
        )
        for i, order in enumerate(orders)
    ]
    try:
        await until(lambda: barrier.pending == 2)
        await settle()
        assert len(barrier.calls) == 2
        barrier.drain()
        receipts = await asyncio.gather(*tasks)
        assert barrier.peak == 2
        assert len({r.operation_ref for r in receipts}) == 10
        assert not {r.operation_ref for r in receipts} & {o.order_ref for o in orders}
        counts = Counter(r.headers["api-id"] for r in broker.requests)
        assert counts == {"ka00001": 10, "ka10075": 10, "kt00007": 10, "kt10002": 10}
        assert not service._tasks
        assert all(not gate.active and not gate.queue for gate in service._kiwoom_gates.values())
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_pair_never_refills_while_first_ack_is_held(setup):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=3)
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(service.execute(modification(adapter, f"pair-{i}"), "modify", o.order_ref))
        for i, o in enumerate(orders)
    ]
    try:
        await until(lambda: barrier.pending == 2)
        barrier.release("0000002")
        await tasks[1]
        await settle()
        assert len(barrier.calls) == 2 and not tasks[0].done() and not tasks[2].done()
        barrier.drain()
        await asyncio.gather(*tasks)
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("writer", ["create", "cancel"])
@pytest.mark.parametrize("writer_first", [False, True])
async def test_code_writer_exclusion_both_directions_and_fifo(setup, writer, writer_first):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=3)
    barrier = WriteBarrier(broker, adapter)
    write_command = (
        CreateBrokerOrder(
            account_ref=adapter.account_ref,
            code="005930",
            command_id="writer",
            side="BUY",
            price=67100,
            quantity=1,
            route="KRX",
        )
        if writer == "create"
        else BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="writer")
    )

    async def submit_writer():
        return await service.execute(write_command, writer, "" if writer == "create" else orders[2].order_ref)

    tasks = []
    try:
        first = asyncio.create_task(
            submit_writer()
            if writer_first
            else service.execute(modification(adapter, "early"), "modify", orders[0].order_ref)
        )
        tasks.append(first)
        await until(lambda: barrier.pending == 1)
        if writer_first:
            tasks.append(
                asyncio.create_task(service.execute(modification(adapter, "late"), "modify", orders[1].order_ref))
            )
        else:
            tasks.append(asyncio.create_task(submit_writer()))
            await settle()
            tasks.append(
                asyncio.create_task(service.execute(modification(adapter, "late"), "modify", orders[1].order_ref))
            )
        await settle()
        assert len(barrier.calls) == 1
        barrier.drain()
        await asyncio.gather(*tasks)
        kinds = [api for api, _ in barrier.calls]
        write_api = "kt10000" if writer == "create" else "kt10003"
        assert kinds == ([write_api, "kt10002"] if writer_first else ["kt10002", write_api, "kt10002"])
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("writer", ["create", "cancel"])
async def test_other_code_create_cancel_do_not_acquire_modify_slots(setup, writer):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=3)
    broker.opens[2]["stk_cd"] = "005931"
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(service.execute(modification(adapter, f"occupied-{i}"), "modify", o.order_ref))
        for i, o in enumerate(orders[:2])
    ]
    try:
        await until(lambda: barrier.pending == 2)
        command = (
            CreateBrokerOrder(
                account_ref=adapter.account_ref,
                code="005931",
                command_id="other",
                side="BUY",
                price=67100,
                quantity=1,
                route="KRX",
            )
            if writer == "create"
            else BrokerCommand(account_ref=adapter.account_ref, code="005931", command_id="other")
        )
        tasks.append(
            asyncio.create_task(service.execute(command, writer, "" if writer == "create" else orders[2].order_ref))
        )
        await until(lambda: barrier.pending == 3)
        barrier.drain()
        await asyncio.gather(*tasks)
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_same_original_different_commands_never_overlap(setup):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(outcome(service.execute(modification(adapter, f"same-{i}"), "modify", order.order_ref)))
        for i in range(2)
    ]
    try:
        await until(lambda: barrier.pending == 1)
        await settle()
        assert len(barrier.calls) == 1
        barrier.drain()
        results = await asyncio.gather(*tasks)
        assert results[1] == "order-not-editable" and len(barrier.calls) == 1
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_child_visible_before_parent_ack_cannot_bypass_even_without_ancestry(setup):
    broker, _, adapter, service, _ = setup
    original = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    parent = asyncio.create_task(service.execute(modification(adapter, "parent"), "modify", original.order_ref))
    tasks = [parent]
    try:
        await until(lambda: barrier.pending == 1)
        # Fake OPEN exposes a child without parent/root fields before the ACK records its lineage.
        child = (await adapter.order_state("005930", fresh=True)).orders[0]
        assert child.order_ref != original.order_ref and child.root_order_id is None
        tasks.append(asyncio.create_task(service.execute(modification(adapter, "child"), "modify", child.order_ref)))
        await settle()
        assert len(barrier.calls) == 1
        barrier.release(original.broker_order_id)
        await parent
        await until(lambda: len(barrier.calls) == 2)
        barrier.drain()
        result = await tasks[1]
        assert result.operation_ref and len(barrier.calls) == 2
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("action", ["modify", "cancel"])
async def test_unknown_parent_blocks_identity_free_child_after_drain(setup, action):
    broker, _, adapter, service, _ = setup
    original = (await targets(broker, adapter, count=1))[0]
    broker.failure = "timeout"
    assert (
        await outcome(service.execute(modification(adapter, "lost"), "modify", original.order_ref))
        == "order-outcome-unknown"
    )
    broker.failure = ""
    child = (await adapter.order_state("005930", fresh=True)).orders[0]
    assert child.root_order_id is None and child.original_order_id is None
    command = (
        modification(adapter, "orphan")
        if action == "modify"
        else BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="orphan")
    )
    assert await outcome(service.execute(command, action, child.order_ref)) == "unresolved-order-exists"
    assert len(broker.writes) == 1


@pytest.mark.parametrize("after_send", [False, True])
async def test_owned_cancellation_records_outcome_and_releases_resources(setup, after_send):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    if not after_send:
        await adapter._snapshot_lock.acquire()
    waiter = asyncio.create_task(service.execute(modification(adapter, "owned-cancel"), "modify", order.order_ref))
    try:
        await until(lambda: "owned-cancel" in service._tasks)
        if after_send:
            await until(lambda: barrier.pending == 1)
        else:
            await settle()
        service._tasks["owned-cancel"].cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert service.journal.lookup("owned-cancel")[1] == ("unknown" if after_send else "rejected")
        assert not service._tasks
        assert all(not g.active and not g.queue for g in service._kiwoom_gates.values())
        assert not any(lock.locked() for lock in service._order_locks.values())
        assert service._modify_slots[adapter.account_ref]._value == 2
    finally:
        if not after_send:
            adapter._snapshot_lock.release()
        barrier.drain()
        await asyncio.gather(waiter, return_exceptions=True)


@pytest.mark.parametrize("case", ["owners", "aliases", "mock-same", "mock-codes"])
async def test_owner_identity_and_mock_cross_code_policy(tmp_path, case):
    mock = case.startswith("mock")
    count = 2 if case in {"owners", "aliases"} else 1
    registry = AccountRegistry(tmp_path / "trading/accounts.sqlite3")
    brokers, adapters, barriers = [], [], []
    legacy = TradingService(tmp_path)
    service = None
    tasks = []
    try:
        for i in range(count):
            broker = Kiwoom(number=str(2222222222 + (0 if case == "aliases" else i)))
            gateway = KiwoomAccountGateway(
                Provider("mock" if mock else "real"),
                environment="mock" if mock else "real",
                account_index=i,
                transport=httpx.MockTransport(broker.handle),
                budget=None if case == "aliases" else KiwoomBudget(interval=0),
            )
            adapter = KiwoomTradingAdapter(gateway, registry, tmp_path)
            brokers.append(broker)
            adapters.append(adapter)
        service = BrokerTradingService(tmp_path, legacy, kiwoom=adapters)
        accounts = await service.accounts()
        assert len(accounts.accounts) == (1 if case == "aliases" else count)
        for i in range(1 if case == "aliases" else count):
            orders = await targets(brokers[i], adapters[i], count=3, different_codes=case == "mock-codes")
            barriers.append(WriteBarrier(brokers[i], adapters[i]))
            tasks.extend(
                asyncio.create_task(
                    service.execute(
                        modification(adapters[i], f"{i}-{j}").model_copy(update={"code": order.code}),
                        "modify",
                        order.order_ref,
                    )
                )
                for j, order in enumerate(orders)
            )
        expected = {"owners": 4, "aliases": 2, "mock-same": 1, "mock-codes": 3}[case]
        await until(lambda: sum(barrier.pending for barrier in barriers) == expected)
        await settle()
        assert sum(len(barrier.calls) for barrier in barriers) == expected
        if case == "aliases":
            assert adapters[0].gateway.budget is adapters[1].gateway.budget
            assert not brokers[1].writes and len(service._modify_slots) == 1
        for barrier in barriers:
            barrier.drain()
        await asyncio.gather(*tasks)
    finally:
        for barrier in barriers:
            barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)
        if service:
            await service.close()
        else:
            for adapter in adapters:
                await adapter.gateway.close()
        await legacy.close()


async def test_queued_expiry_starts_no_additional_reads_or_sending(setup, monkeypatch):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=3)
    now = time.monotonic()
    clock = SimpleNamespace(monotonic=lambda: now, time=time.time)
    monkeypatch.setattr(multi_broker, "time", clock)
    monkeypatch.setattr(kiwoom_admission, "time", clock)
    monkeypatch.setattr(kiwoom, "time", clock)
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(outcome(service.execute(modification(adapter, f"expire-{i}"), "modify", o.order_ref)))
        for i, o in enumerate(orders)
    ]
    try:
        await until(lambda: barrier.pending == 2)
        before = len(broker.requests)
        now += 11
        barrier.drain()
        results = await asyncio.gather(*tasks)
        assert results[2] == "order-queue-expired" and len(broker.requests) == before
        assert service.journal.lookup("expire-2")[1] == "rejected"
        assert len(broker.writes) == 2
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_deadline_stops_next_page_without_partial_snapshot_or_write(setup, monkeypatch):
    broker, _, adapter, service, _ = setup
    target = (await targets(broker, adapter, count=1))[0]
    now = time.monotonic()
    clock = SimpleNamespace(monotonic=lambda: now, time=time.time)
    monkeypatch.setattr(multi_broker, "time", clock)
    monkeypatch.setattr(kiwoom_admission, "time", clock)
    monkeypatch.setattr(kiwoom, "time", clock)
    original = broker.handle
    pages = []

    async def page(request):
        nonlocal now
        if request.headers["api-id"] == "ka10075":
            pages.append(request.headers["next-key"])
            now += 11
            return httpx.Response(
                200,
                json={"return_code": 0, "oso": broker.opens},
                headers={"cont-yn": "Y", "next-key": "fixture-next-page"},
            )
        return await original(request)

    adapter.gateway.http._transport = httpx.MockTransport(page)
    result = await outcome(service.execute(modification(adapter, "page-expire"), "modify", target.order_ref))
    assert result == "order-queue-expired" and pages == [""] and not broker.writes
    assert not adapter._snapshots
    assert service.journal.lookup("page-expire")[1] == "rejected"


async def test_close_drains_owned_command_after_http_waiter_cancellation(setup):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    waiter = asyncio.create_task(service.execute(modification(adapter, "http-cancel"), "modify", order.order_ref))
    closing = None
    try:
        await until(lambda: barrier.pending == 1)
        waiter.cancel()
        with pytest.raises(asyncio.CancelledError):
            await waiter
        assert "http-cancel" in service._tasks
        closing = asyncio.create_task(service.close())
        await settle()
        assert not closing.done() and not adapter.gateway.http.is_closed
        barrier.drain()
        await closing
        assert service.journal.lookup("http-cancel")[1] == "accepted"
        assert not service._tasks and adapter.gateway.http.is_closed
        assert service._modify_slots[adapter.account_ref]._value == 2
        assert all(not g.active and not g.queue for g in service._kiwoom_gates.values())
    finally:
        barrier.drain()
        if closing:
            await closing
        await asyncio.gather(waiter, return_exceptions=True)


async def test_partial_pair_unknown_keeps_independent_member_and_blocks_next_cohort(setup):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=3)
    barrier = WriteBarrier(broker, adapter)
    barrier.lost.add("0000001")
    tasks = [
        asyncio.create_task(outcome(service.execute(modification(adapter, f"partial-{i}"), "modify", o.order_ref)))
        for i, o in enumerate(orders)
    ]
    try:
        await until(lambda: barrier.pending == 2)
        barrier.release("0000001")
        assert await tasks[0] == "order-outcome-unknown"
        await settle()
        assert len(barrier.calls) == 2 and not tasks[1].done() and not tasks[2].done()
        barrier.drain()
        results = await asyncio.gather(*tasks)
        assert results[1].operation_ref and results[2] == "unresolved-order-exists"
        assert [service.journal.lookup(f"partial-{i}")[1] for i in range(3)] == ["unknown", "accepted", "rejected"]
        assert len(barrier.calls) == 2
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_active_duplicate_and_accepted_replay_use_one_slot_and_one_write(setup):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    command = modification(adapter, "duplicate")
    tasks = [asyncio.create_task(service.execute(command, "modify", order.order_ref)) for _ in range(2)]
    try:
        await until(lambda: barrier.pending == 1)
        await settle()
        assert len(service._tasks) == len(barrier.calls) == 1
        barrier.drain()
        results = await asyncio.gather(*tasks)
        assert results[0] == results[1] == await service.execute(command, "modify", order.order_ref)
        assert len(barrier.calls) == 1 and service._modify_slots[adapter.account_ref]._value == 2
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("first_action", ["modify", "cancel"])
async def test_same_original_modify_cancel_are_exclusive(setup, first_action):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    barrier = WriteBarrier(broker, adapter)
    base = BrokerCommand(account_ref=adapter.account_ref, code="005930", command_id="cancel")
    modify = modification(adapter, "modify")
    first = asyncio.create_task(
        service.execute(modify if first_action == "modify" else base, first_action, order.order_ref)
    )
    second = None
    try:
        await until(lambda: barrier.pending == 1)
        second = asyncio.create_task(
            outcome(
                service.execute(
                    base if first_action == "modify" else modify,
                    "cancel" if first_action == "modify" else "modify",
                    order.order_ref,
                )
            )
        )
        await settle()
        assert len(barrier.calls) == 1
        barrier.drain()
        await first
        assert await second == "order-not-editable" and len(barrier.calls) == 1
    finally:
        barrier.drain()
        await asyncio.gather(first, *([second] if second else []), return_exceptions=True)


async def test_wrong_action_rejection_and_missing_history_after_restart_do_not_release_old(setup):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    await service.execute(modification(adapter, "accepted-parent"), "modify", order.order_ref)
    broker.opens = [open_order()]
    broker.history[-1].update(acpt_tp="거부", io_tp_nm="매수취소")
    assert (
        await outcome(service.execute(modification(adapter, "wrong-action"), "modify", order.order_ref))
        == "order-processing"
    )
    broker.history = []
    restarted = BrokerTradingService(service.data_dir, service.legacy, kiwoom=[adapter])
    try:
        assert (
            await outcome(restarted.execute(modification(adapter, "history-missing"), "modify", order.order_ref))
            == "order-processing"
        )
        assert len(broker.writes) == 1
    finally:
        await restarted.close()


async def test_observed_fill_on_second_member_is_rechecked_after_budget(setup, monkeypatch):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=2)
    barrier = WriteBarrier(broker, adapter)
    acquire = adapter.gateway.budget.acquire
    calls = 0

    async def event_during_admission(api_id, **kwargs):
        nonlocal calls
        await acquire(api_id, **kwargs)
        if api_id == "kt10002":
            calls += 1
            if calls == 2:
                adapter.account_event(
                    {
                        "type": "00",
                        "values": {"9201": adapter._account_no, "9203": "0000002", "902": "0", "913": "체결"},
                    },
                    1,
                )

    monkeypatch.setattr(adapter.gateway.budget, "acquire", event_during_admission)
    tasks = [
        asyncio.create_task(outcome(service.execute(modification(adapter, f"fill-{i}"), "modify", o.order_ref)))
        for i, o in enumerate(orders)
    ]
    try:
        assert await tasks[1] == "order-state-syncing"
        assert len(barrier.calls) == 1
        barrier.drain()
        assert (await tasks[0]).operation_ref
        assert service.journal.lookup("fill-1")[1] == "rejected"
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_close_drains_existing_bulk_children_but_rejects_new_external_work(setup):
    broker, _, adapter, service, _ = setup
    await targets(broker, adapter, count=3)
    barrier = WriteBarrier(broker, adapter)
    command = CancelBrokerOrders(account_ref=adapter.account_ref, code="005930", command_id="bulk-close")
    batch = asyncio.create_task(service.cancel_all(command))
    closing = None
    try:
        await until(lambda: barrier.pending == 1)
        closing = asyncio.create_task(service.close())
        await settle()
        assert not closing.done()
        assert (
            await outcome(service.execute(modification(adapter, "external-during-close"), "modify", "unused"))
            == "trading-closing"
        )
        barrier.drain()
        result = await batch
        await closing
        assert len(result["results"]) == 3 and all(item["accepted"] for item in result["results"])
        assert len(barrier.calls) == 3 and adapter.gateway.http.is_closed
        assert not service._tasks and not service._batches
    finally:
        barrier.drain()
        await asyncio.gather(batch, *([closing] if closing else []), return_exceptions=True)


@pytest.mark.parametrize("rejection_first", [True, False])
async def test_contradictory_exact_operation_rows_never_authorize_old_target(setup, rejection_first):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    await service.execute(modification(adapter, "contradiction-parent"), "modify", order.order_ref)
    broker.opens = [open_order()]
    success = dict(broker.history[-1])
    rejection = {**success, "acpt_tp": "거부"}
    broker.history = [rejection, success] if rejection_first else [success, rejection]
    assert (
        await outcome(service.execute(modification(adapter, "contradictory-retry"), "modify", order.order_ref))
        == "order-processing"
    )
    assert len(broker.writes) == 1


async def test_operation_still_in_open_does_not_hide_conflicting_history_and_release_old(setup):
    broker, _, adapter, service, _ = setup
    order = (await targets(broker, adapter, count=1))[0]
    await service.execute(modification(adapter, "open-contradiction-parent"), "modify", order.order_ref)
    replacement = dict(broker.opens[0])
    replacement.update(ord_stt="거부", io_tp_nm="매수정정", orig_ord_no=order.broker_order_id)
    broker.opens = [open_order(), replacement]
    assert (
        await outcome(service.execute(modification(adapter, "open-contradictory-retry"), "modify", order.order_ref))
        == "order-processing"
    )
    assert len(broker.writes) == 1


@pytest.mark.parametrize("ambiguous_first", [True, False])
async def test_duplicated_leader_identity_never_establishes_parallel_fence(setup, ambiguous_first):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=2)
    plain = dict(broker.opens[0])
    ambiguous = {**plain, "io_tp_nm": "매수정정", "ord_stt": "확인", "orig_ord_no": "0000002"}
    broker.opens = ([ambiguous, plain] if ambiguous_first else [plain, ambiguous]) + [broker.opens[1]]
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(service.execute(modification(adapter, f"duplicate-leader-{i}"), "modify", o.order_ref))
        for i, o in enumerate(orders)
    ]
    try:
        await until(lambda: barrier.pending == 1)
        await settle()
        assert len(barrier.calls) == 1
        barrier.drain()
        await asyncio.gather(*tasks)
        assert barrier.peak == 1
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("ambiguous_first", [True, False])
async def test_new_duplicate_follower_identity_invalidates_frozen_proof(setup, ambiguous_first):
    broker, _, adapter, service, _ = setup
    orders = await targets(broker, adapter, count=2)
    original = broker.handle

    async def duplicate_after_first_send(request):
        response = await original(request)
        if request.headers["api-id"] == "kt10002" and json.loads(request.content)["orig_ord_no"] == "0000001":
            plain = next(dict(row) for row in broker.opens if row["ord_no"] == "0000002")
            ambiguous = {**plain, "io_tp_nm": "매수정정", "ord_stt": "확인", "orig_ord_no": "0000001"}
            broker.opens = [row for row in broker.opens if row["ord_no"] != "0000002"]
            broker.opens.extend([ambiguous, plain] if ambiguous_first else [plain, ambiguous])
        return response

    broker.handle = duplicate_after_first_send
    barrier = WriteBarrier(broker, adapter)
    tasks = [
        asyncio.create_task(
            outcome(service.execute(modification(adapter, f"duplicate-follower-{i}"), "modify", o.order_ref))
        )
        for i, o in enumerate(orders)
    ]
    try:
        assert await tasks[1] == "order-state-syncing"
        assert len(barrier.calls) == 1
        barrier.drain()
        assert (await tasks[0]).operation_ref
    finally:
        barrier.drain()
        await asyncio.gather(*tasks, return_exceptions=True)
