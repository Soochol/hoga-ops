import asyncio
from types import SimpleNamespace

import pytest

from hoga.live import kiwoom_session as session, kiwoom_ws_client as wire
from hoga.live.buffer import LiveBuffer
from tests.unit.live.test_kiwoom_session_retirement import Socket, client


async def until(predicate):
    async with asyncio.timeout(5):
        while not predicate():
            await asyncio.sleep(0)


@pytest.fixture
async def live_accounts(tmp_path, monkeypatch):
    monkeypatch.setattr(wire, '_REG_PACING_S', 0)
    monkeypatch.setattr(wire, '_BACKOFF_S', (0,))
    manager = session.KiwoomSessionManager(buffer=LiveBuffer(), data_dir=tmp_path, date_fn=lambda: '20261102')
    sockets, flush_done, flush_cancels = [], set(), []
    flush_entered, flush_release = asyncio.Event(), asyncio.Event()
    final = []

    async def flush(index):
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            flush_cancels.append(index)
            if index == 0:
                flush_entered.set()
                await flush_release.wait()
            (tmp_path / f'flush-{index}').write_text('stored')
            flush_done.add(index)
            raise

    connections = []
    for index in range(5):
        socket = Socket(hang_close=True)
        instance = client(lambda _, socket=socket: asyncio.sleep(0, result=socket), account_id=index)
        conn = session._KiwoomConn(index, object(), instance,
            asyncio.create_task(instance.run(['005930'])), asyncio.create_task(flush(index)), ('005930',))
        manager._conns[index] = conn
        connections.append(conn)
        sockets.append(socket)

    class Seconds:
        async def finish_flush(self, **kwargs):
            assert flush_done == set(range(5))
            assert all(socket.terminated.is_set() and not socket.receiver_active for socket in sockets)
            assert all(conn.ws_task.done() and conn.flush_task.done() for conn in connections)
            final.append(True)

    manager._seconds = Seconds()
    await until(lambda: all(conn.client.registration_ready for conn in connections))
    yield SimpleNamespace(manager=manager, sockets=sockets, connections=connections, final=final,
                          flush_entered=flush_entered, flush_release=flush_release,
                          flush_cancels=flush_cancels)
    for socket in sockets:
        socket.close_release.set()
    flush_release.set()
    await manager.stop()


async def test_all_accounts_begin_close_before_any_close_finishes(live_accounts):
    probe = live_accounts
    stopping = asyncio.create_task(probe.manager.stop())
    await until(lambda: all(socket.close_entered.is_set() for socket in probe.sockets))
    assert not stopping.done() and not probe.final
    for socket in probe.sockets:
        socket.close_release.set()
    await probe.flush_entered.wait()
    assert not stopping.done() and not probe.final
    probe.flush_release.set()
    await stopping
    assert probe.final == [True]
    assert sorted(probe.flush_cancels) == list(range(5))
    assert not probe.manager._lock.locked()


async def test_cancelled_and_repeated_stop_keep_lock_until_flush_ack(live_accounts):
    probe = live_accounts
    first = asyncio.create_task(probe.manager.stop())
    await until(lambda: all(socket.close_entered.is_set() for socket in probe.sockets))
    for _ in range(2):
        first.cancel()
        await asyncio.sleep(0)
        assert not first.done() and probe.manager._lock.locked()
    second = asyncio.create_task(probe.manager.stop())
    for socket in probe.sockets:
        socket.close_release.set()
    await probe.flush_entered.wait()
    assert not second.done() and not probe.final
    probe.flush_release.set()
    with pytest.raises(asyncio.CancelledError):
        await first
    await second
    assert probe.final == [True]
    assert sorted(probe.flush_cancels) == list(range(5))
    assert all(socket.aborts == 0 for socket in probe.sockets)
    assert all(conn.client.connection_generation == 1 for conn in probe.connections)


async def test_one_account_close_error_aborts_it_without_skipping_other_accounts(live_accounts, monkeypatch):
    probe = live_accounts

    async def failed_close():
        probe.sockets[0].close_entered.set()
        raise OSError('socket close failed')

    monkeypatch.setattr(probe.sockets[0], 'close', failed_close)
    stopping = asyncio.create_task(probe.manager.stop())
    await until(lambda: all(socket.close_entered.is_set() for socket in probe.sockets))
    assert probe.sockets[0].aborts == 1 and not stopping.done()
    for socket in probe.sockets:
        socket.close_release.set()
    probe.flush_release.set()
    await stopping
    assert probe.final == [True]
    assert all(socket.terminated.is_set() for socket in probe.sockets)


async def test_live_stop_resets_state_before_propagating_caller_cancel(monkeypatch):
    from hoga.live import lifecycle

    entered, release = asyncio.Event(), asyncio.Event()

    async def stop():
        entered.set()
        await release.wait()

    original = lifecycle._State(kiwoom_session=SimpleNamespace(stop=stop))
    monkeypatch.setattr(lifecycle, '_state', original)
    caller = asyncio.create_task(lifecycle.stop_live_stream())
    await entered.wait()
    caller.cancel()
    await asyncio.sleep(0)
    assert not caller.done() and lifecycle._lifecycle_lock.locked()
    release.set()
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert lifecycle._state is not original
    assert not lifecycle._lifecycle_lock.locked()
