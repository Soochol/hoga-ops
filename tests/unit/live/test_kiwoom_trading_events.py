from __future__ import annotations

import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live import account_events
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_worker import CollectorWorker
from hoga.live.kiwoom_budget import KiwoomBudget, bind_budget, budget_for
from hoga.live.kiwoom_ws_client import KiwoomDataBacklogError, KiwoomWsClient
from tests.unit.live.test_kiwoom_ws_client import REAL_0D, FakeServer

CONTRACT = json.loads((Path(__file__).parents[2] / "fixtures/kiwoom_trading/official_contract.json").read_text())


async def until(predicate):
    async def wait():
        while not predicate():
            await asyncio.sleep(0)
    await asyncio.wait_for(wait(), 3)


async def stop(task):
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


@pytest.fixture
def client_factory(monkeypatch):
    monkeypatch.setattr("hoga.live.kiwoom_ws_client._REG_PACING_S", 0)

    def factory(ws, **kwargs):
        async def connect(_url):
            return ws
        return KiwoomWsClient(token_fn=AsyncMock(return_value="token"), on_tick=AsyncMock(),
                               date_fn=lambda: "20260716", _connect=connect, **kwargs)
    return factory


async def test_account_and_market_frames_share_reader_but_have_separate_delivery(client_factory):
    ws = FakeServer()
    rows, states = AsyncMock(), AsyncMock()
    client = client_factory(ws, account_events=True, on_account_row=rows, on_account_state=states)
    task = asyncio.create_task(client._session_once())
    try:
        await until(lambda: client._registration_finished)
        account = CONTRACT["apis"]["00"]["frame"]["data"][0]
        balance = CONTRACT["apis"]["04"]["frame"]["data"][0]
        ws.push(json.dumps({"trnm": "REAL", "data": [account, *REAL_0D["data"], balance]}))
        await until(lambda: rows.await_count == 2 and client._on_tick.await_count == 1)
        assert rows.await_args_list[0].args == (account, 1)
        assert rows.await_args_list[1].args == (balance, 1)
        assert states.await_args_list[0].args == (True, 1)
        account_reg = [json.loads(raw) for raw in ws.sent if '"grp_no": "4"' in raw]
        assert account_reg[0]["data"] == [{"item": [""], "type": ["00", "04"]}]
    finally:
        await stop(task)
    assert states.await_args_list[-1].args == (False, 1)


async def test_blocked_account_consumer_cannot_block_market_registration_or_ping(client_factory):
    ws = FakeServer()
    entered, release = asyncio.Event(), asyncio.Event()

    async def blocked(_row, _generation):
        entered.set()
        await release.wait()

    client = client_factory(ws, account_events=True, on_account_row=blocked)
    task = asyncio.create_task(client._session_once())
    try:
        await until(lambda: client._registration_finished)
        ws.push(json.dumps(CONTRACT["apis"]["00"]["frame"]))
        await asyncio.wait_for(entered.wait(), 3)
        ws.push(json.dumps({"trnm": "PING"}))
        await asyncio.wait_for(client.update_codes(["005930"]), 3)
        await until(lambda: any(json.loads(raw).get("trnm") == "PING" for raw in ws.sent))
        assert client.sub_acked == 1 and client.account_events_acked
    finally:
        release.set()
        await stop(task)


async def test_account_queue_overflow_retires_and_marks_connection_unavailable(client_factory):
    ws = FakeServer()
    release, entered = asyncio.Event(), asyncio.Event()

    async def blocked(*_args):
        entered.set()
        await release.wait()

    states = AsyncMock()
    client = client_factory(ws, account_events=True, on_account_row=blocked, on_account_state=states)
    task = asyncio.create_task(client._session_once())
    try:
        await until(lambda: client._registration_finished)
        row = CONTRACT["apis"]["00"]["frame"]["data"][0]
        ws.push(json.dumps({"trnm": "REAL", "data": [row]}))
        await asyncio.wait_for(entered.wait(), 3)
        ws.push(json.dumps({"trnm": "REAL", "data": [row] * 129}))
        with pytest.raises(KiwoomDataBacklogError, match="account event"):
            await asyncio.wait_for(task, 3)
        assert not client.connected
        assert states.await_args_list[-1].args[0] is False
    finally:
        release.set()
        await stop(task)


async def test_market_remove_and_account_remove_use_different_groups(client_factory):
    ws = FakeServer()
    client = client_factory(ws, account_events=True, on_account_row=AsyncMock())
    client._codes = ["005930"]
    task = asyncio.create_task(client._session_once())
    try:
        await until(lambda: client._registration_finished)
        await client.update_codes([])
        assert client.account_events_acked
        await client.set_account_events(False)
        assert not client.account_events_acked
        await client.set_account_events(True)
        assert client.account_events_acked
        removals = [json.loads(raw) for raw in ws.sent if json.loads(raw).get("trnm") == "REMOVE"]
        assert [r["grp_no"] for r in removals] == ["1", "4"]
    finally:
        await stop(task)


async def test_account_registration_is_restored_after_reconnect(client_factory):
    ws = FakeServer()
    states = AsyncMock()
    client = client_factory(ws, account_events=True, on_account_row=AsyncMock(), on_account_state=states)
    first = asyncio.create_task(client._session_once())
    await until(lambda: client._registration_finished)
    await stop(first)
    next_ws = FakeServer()

    async def connect(_url):
        return next_ws

    client._connect = connect
    second = asyncio.create_task(client._session_once())
    try:
        await until(lambda: client.connection_generation == 2 and client._registration_finished)
        assert any(json.loads(raw).get("grp_no") == "4" for raw in next_ws.sent)
        assert [call.args for call in states.await_args_list][:3] == [(True, 1), (False, 1), (True, 2)]
    finally:
        await stop(second)


async def test_account_lease_keeps_empty_market_session_alive_when_gate_closes(monkeypatch, krx_only_master):
    from tests.unit.live import test_kiwoom_session as helpers

    original = helpers._FakeClient

    class LeaseClient(original):
        async def set_account_events(self, enabled):
            self.account_events = enabled

    monkeypatch.setattr(helpers, "_FakeClient", LeaseClient)
    manager, _ = helpers._fake_manager(gate_fn=lambda: False)
    try:
        await manager.sync(("005930",), n_accounts=1)
        await manager.retain_account(0)
        await manager.sync((), n_accounts=1)
        assert list(manager._conns) == [0]
        assert manager._conns[0].client.account_events
        assert not manager._conns[0].ws_task.done()
        await manager.release_account(0)
        assert not manager._conns
    finally:
        await manager.stop()


async def test_collector_control_lane_delivers_private_events_and_rejects_unsolicited_accounts(tmp_path):
    owner = CaptureProcessSession(buffer=SimpleNamespace(), data_dir=tmp_path)
    owner.config = {"n_accounts": 1}
    owner.account_refs = {0}
    row = CONTRACT["apis"]["00"]["frame"]["data"][0]
    delivered = []
    listener = (lambda value, generation: delivered.append((value, generation)), lambda connected: None)
    account_events._listeners[("real", 0)].add(listener)
    replies = []

    async def reply(command, **kwargs):
        replies.append((command, kwargs))

    peer = SimpleNamespace(commands=asyncio.Queue(), reply=reply)
    task = asyncio.create_task(owner._tokens(peer))
    try:
        await peer.commands.put({"method": "account_event", "args": {"account": 0, "row": row, "generation": 3}})
        await peer.commands.put({"method": "account_event", "args": {"account": 1, "row": row, "generation": 3}})
        await until(lambda: len(replies) == 2)
        assert delivered == [(row, 3)]
        assert replies[0][1] == {"result": True}
        assert "error" in replies[1][1]
    finally:
        account_events._listeners[("real", 0)].discard(listener)
        await stop(task)


async def test_worker_private_frames_use_reliable_rpc_not_lossy_display(tmp_path):
    peer = SimpleNamespace(call=AsyncMock(return_value=True))
    worker = CollectorWorker(tmp_path, "epoch", peer, manager_factory=lambda **kwargs: SimpleNamespace())
    row = CONTRACT["apis"]["00"]["frame"]["data"][0]
    await worker.account_row(0, row, 4)
    await worker.account_state(0, True, 4)
    assert peer.call.await_args_list[0].args == ("account_event", {"account": 0, "row": row, "generation": 4})
    assert peer.call.await_args_list[1].args[0] == "account_state"
    assert not worker.display.frames and not worker.state_outbox.frames


async def test_shared_budget_combines_credentials_bound_to_same_account():
    class Provider:
        pass
    first, second = Provider(), Provider()
    assert budget_for(first) is not budget_for(second)
    assert bind_budget(first, "synthetic-account-budget") is bind_budget(second, "synthetic-account-budget")
    assert budget_for(first) is budget_for(second)


async def test_budget_groups_mock_tr_limit_and_deadline_are_independent(monkeypatch):
    clock, delays = [0.0], []
    monkeypatch.setattr("hoga.live.kiwoom_budget.time.monotonic", lambda: clock[0])

    async def sleep(delay):
        delays.append(delay)
        clock[0] += delay

    monkeypatch.setattr("hoga.live.kiwoom_budget.asyncio.sleep", sleep)
    budget = KiwoomBudget(mock=True, interval=0)
    await budget.acquire("ka00001")
    await budget.acquire("kt10000", write=True)
    assert delays == []
    assert budget.available_at("ka00001") == 1.05
    assert budget.available_at("ka10081") == 0
    assert budget.available_at("kt10000", write=True) == 1.05
    assert delays == []  # Observation neither waits nor reserves another slot.
    with pytest.raises(TimeoutError):
        await budget.acquire("kt10000", write=True, deadline=1)
    await budget.acquire("ka00001")
    assert delays == [1.05]


async def test_market_read_gate_follows_later_account_budget_binding(monkeypatch):
    from hoga.live.kiwoom_rest import KiwoomRestClient

    class Provider:
        pass

    monkeypatch.setattr("hoga.live.kiwoom_budget.time.monotonic", lambda: 100.0)
    first, second = Provider(), Provider()
    clients = [KiwoomRestClient(p) for p in (first, second)]
    try:
        assert clients[0].read_available_at("ka10081") == 100
        budget_for(second)._next["read"] = 110
        bind_budget(first, "synthetic-late-budget-binding")
        bind_budget(second, "synthetic-late-budget-binding")
        assert [c.read_available_at("ka10081") for c in clients] == [110, 110]
        assert budget_for(first).available_at("kt10000", write=True) == 100
    finally:
        for client in clients:
            await client.aclose()
