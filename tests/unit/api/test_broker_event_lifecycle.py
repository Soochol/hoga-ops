from __future__ import annotations

import asyncio
from collections import defaultdict
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from hoga.live import account_events, kiwoom_runtime, lifecycle, storage_runtime
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.kiwoom_budget import KiwoomBudget
from hoga.trading.kiwoom import KiwoomAccountGateway, KiwoomTradingAdapter
from tests.unit.api import test_broker_trading as brokers

broker_setup = brokers.setup


async def settled():
    for _ in range(10):
        await asyncio.sleep(0)


@pytest.fixture
async def events(broker_setup, monkeypatch):
    broker, _, adapter, service, api = broker_setup
    monkeypatch.setattr(account_events, "_listeners", defaultdict(set))
    monkeypatch.setattr(account_events, "_states", {})
    monkeypatch.setattr(kiwoom_runtime, "ensure_token_provider_for_account", lambda *_a, **_kw: object())
    monkeypatch.setattr(kiwoom_runtime, "configured_account_ids", lambda *_a, **_kw: [0, 1])
    monkeypatch.setattr(lifecycle, "get_buffer", lambda: None)
    owner = CaptureProcessSession(buffer=SimpleNamespace(), data_dir=service.data_dir)
    state = SimpleNamespace(
        owner=owner, entered=asyncio.Event(), proceed=asyncio.Event(), syncs=0,
        failure=None, releases=[], broker=broker, adapter=adapter, service=service, api=api,
    )

    async def sync(*_args, **_kwargs):
        state.syncs += 1
        state.entered.set()
        await state.proceed.wait()
        if state.failure:
            raise state.failure

    original_release = owner.release_account

    async def release(account):
        state.releases.append(account)
        await original_release(account)

    monkeypatch.setattr(owner, "sync", sync)
    monkeypatch.setattr(owner, "release_account", release)
    monkeypatch.setattr(storage_runtime, "_ensure_kiwoom_session", lambda *_a, **_kw: owner)
    try:
        yield state
    finally:
        state.proceed.set()
        await service.close()


async def read(events, adapter=None):
    return await events.api.get(
        "/api/trading/v2/state",
        params={"account_ref": (adapter or events.adapter).account_ref, "code": "005930", "part": "orders"},
    )


async def assert_one_event(events):
    revision = events.adapter.revision
    await account_events.dispatch_account_event(
        "real", 0,
        {"type": "00", "values": {"9201": events.broker.number, "9203": "0000001", "902": "40", "913": "체결"}},
        1,
    )
    assert events.adapter.revision - revision == 1


async def test_overlapping_asgi_reads_deliver_each_account_event_once(events):
    readers = [asyncio.create_task(read(events)) for _ in range(2)]
    await events.entered.wait()
    await settled()
    events.proceed.set()
    responses = await asyncio.gather(*readers)
    assert [r.status_code for r in responses] == [200, 200]
    await assert_one_event(events)
    assert events.syncs == 1
    await events.service.close()
    assert events.owner.account_refs == set()
    assert not account_events._listeners.get(("real", 0))
    assert events.releases == [0]


async def test_distinct_accounts_register_in_parallel(events):
    broker = brokers.Kiwoom("2222222222")
    gateway = KiwoomAccountGateway(
        brokers.Provider(), account_index=1,
        transport=httpx.MockTransport(broker.handle), budget=KiwoomBudget(interval=0),
    )
    second = KiwoomTradingAdapter(gateway, events.service.registry, events.service.data_dir)
    events.service._kiwoom.append(second)
    await events.service.accounts()
    readers = [asyncio.create_task(read(events, adapter)) for adapter in (events.adapter, second)]
    try:
        await events.entered.wait()
        await settled()
        assert events.owner.account_refs == {0, 1}
    finally:
        events.proceed.set()
        responses = await asyncio.gather(*readers)
    assert [r.status_code for r in responses] == [200, 200]
    await events.service.close()
    assert events.owner.account_refs == set()
    assert sorted(events.releases) == [0, 1]


@pytest.mark.parametrize("cancelled", [(0,), (1,), (0, 1)])
async def test_cancelling_readers_preserves_shared_registration_and_retry(events, cancelled):
    readers = [asyncio.create_task(read(events)) for _ in range(2)]
    await events.entered.wait()
    await settled()
    for index in cancelled:
        readers[index].cancel()
    await asyncio.gather(*(readers[index] for index in cancelled), return_exceptions=True)
    events.proceed.set()
    results = await asyncio.gather(*readers, return_exceptions=True)
    for index, result in enumerate(results):
        assert isinstance(result, asyncio.CancelledError) if index in cancelled else result.status_code == 200
    assert (await read(events)).status_code == 200
    await assert_one_event(events)
    assert events.syncs == 1
    await events.service.close()
    assert events.owner.account_refs == set()
    assert events.releases == [0]


async def test_failed_retain_falls_back_without_desired_reference_and_retries(events):
    events.failure = ConnectionError("synthetic retain failure")
    events.proceed.set()
    assert (await read(events)).status_code == 200
    assert events.owner.account_refs == set()
    assert not account_events._listeners.get(("real", 0))
    events.failure = None
    assert (await read(events)).status_code == 200
    await assert_one_event(events)
    await events.service.close()
    assert events.owner.account_refs == set()
    assert events.releases == [0, 0]


async def test_close_owns_pending_registration_and_closes_admission(events, monkeypatch):
    gateway_close = AsyncMock()
    monkeypatch.setattr(events.adapter.gateway, "close", gateway_close)
    reader = asyncio.create_task(events.service.ensure_events(events.adapter))
    await events.entered.wait()
    closing = asyncio.create_task(events.service.close())
    await settled()
    try:
        assert not closing.done()
        assert gateway_close.await_count == 0
    finally:
        events.proceed.set()
        await asyncio.gather(reader, closing)
    assert events.owner.account_refs == set()
    assert events.releases == [0]
    syncs = events.syncs
    await events.service.ensure_events(events.adapter)
    assert events.syncs == syncs
    assert events.owner.account_refs == set()


async def test_concurrent_close_waits_for_orders_release_and_gateway_once(events, monkeypatch):
    events.proceed.set()
    await events.service.ensure_events(events.adapter)
    order_done, release_done, gateway_done = asyncio.Event(), asyncio.Event(), asyncio.Event()
    release_entered, gateway_entered = asyncio.Event(), asyncio.Event()
    original_release = events.owner.release_account

    async def release(account):
        release_entered.set()
        await release_done.wait()
        await original_release(account)

    async def close_gateway():
        gateway_entered.set()
        await gateway_done.wait()

    gateway_close = AsyncMock(side_effect=close_gateway)
    monkeypatch.setattr(events.owner, "release_account", release)
    monkeypatch.setattr(events.adapter.gateway, "close", gateway_close)
    events.service._tasks["pending-order"] = asyncio.create_task(order_done.wait())
    closers = [asyncio.create_task(events.service.close()) for _ in range(2)]
    try:
        await settled()
        assert not release_entered.is_set()
        assert not gateway_entered.is_set()
        order_done.set()
        await release_entered.wait()
        await settled()
        assert not any(task.done() for task in closers)
        assert not gateway_entered.is_set()
        release_done.set()
        await gateway_entered.wait()
        await settled()
        assert not any(task.done() for task in closers)
    finally:
        order_done.set()
        release_done.set()
        gateway_done.set()
        await asyncio.gather(*closers)
    await events.service.close()
    assert events.releases == [0]
    assert gateway_close.await_count == 1
    assert events.owner.account_refs == set()


async def test_cancelled_close_reader_does_not_abandon_cleanup(events):
    reader = asyncio.create_task(events.service.ensure_events(events.adapter))
    await events.entered.wait()
    closing = asyncio.create_task(events.service.close())
    await settled()
    closing.cancel()
    await asyncio.gather(closing, return_exceptions=True)
    events.proceed.set()
    await reader
    await events.service.close()
    assert events.owner.account_refs == set()
    assert events.releases == [0]


async def test_failed_second_listener_preserves_healthy_account_lease(events):
    events.proceed.set()
    deliveries = []
    release = await account_events.subscribe_account(
        events.service.data_dir, "real", 0, lambda *_: deliveries.append("healthy"), lambda _: None,
    )
    events.failure = ConnectionError("second retain failed")
    with pytest.raises(ConnectionError, match="second retain failed"):
        await account_events.subscribe_account(
            events.service.data_dir, "real", 0, lambda *_: deliveries.append("failed"), lambda _: None,
        )
    assert events.owner.account_refs == {0}
    await account_events.dispatch_account_event("real", 0, {}, 1)
    assert deliveries == ["healthy"]
    await release()
    await release()
    assert events.owner.account_refs == set()
    assert events.releases == [0]


async def test_cancelled_lower_level_retain_rolls_back_desired_reference(events):
    subscribing = asyncio.create_task(account_events.subscribe_account(
        events.service.data_dir, "real", 0, lambda *_: None, lambda _: None,
    ))
    await events.entered.wait()
    subscribing.cancel()
    await asyncio.gather(subscribing, return_exceptions=True)
    assert events.owner.account_refs == set()
    assert not account_events._listeners.get(("real", 0))


async def test_detached_unexpected_failure_is_observed_and_next_read_retries(events):
    loop = asyncio.get_running_loop()
    unhandled = []
    previous_handler = loop.get_exception_handler()
    loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
    try:
        reader = asyncio.create_task(events.service.ensure_events(events.adapter))
        await events.entered.wait()
        reader.cancel()
        await asyncio.gather(reader, return_exceptions=True)
        events.failure = ValueError("synthetic unexpected failure")
        events.proceed.set()
        await settled()
        assert events.owner.account_refs == set()
        assert not any("never retrieved" in context["message"] for context in unhandled)
        events.failure = None
        assert (await read(events)).status_code == 200
        await assert_one_event(events)
    finally:
        loop.set_exception_handler(previous_handler)


async def test_rollback_failure_preserves_original_retain_error(events, monkeypatch, caplog):
    original_release = events.owner.release_account

    async def release(account):
        await original_release(account)
        raise OSError("SECRET-account-1111111111 rollback transport failed")

    monkeypatch.setattr(events.owner, "release_account", release)
    events.failure = ValueError("original retain failed")
    events.proceed.set()
    with pytest.raises(ValueError, match="original retain failed"):
        await account_events.subscribe_account(
            events.service.data_dir, "real", 0, lambda *_: None, lambda _: None,
        )
    assert events.owner.account_refs == set()
    assert any(record.name == "hoga.live.account_events" and "OSError" in record.message for record in caplog.records)
    assert "SECRET-account-1111111111" not in caplog.text


async def test_unexpected_registration_failure_reaches_reader_and_allows_retry(events):
    events.failure = ValueError("unexpected retain failure")
    events.proceed.set()
    with pytest.raises(ValueError, match="unexpected retain failure"):
        await events.service.ensure_events(events.adapter)
    assert events.owner.account_refs == set()
    events.failure = None
    assert (await read(events)).status_code == 200
    await assert_one_event(events)
