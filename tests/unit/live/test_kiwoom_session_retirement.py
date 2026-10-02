"""Retirement ends the owned receiver and transport before replacement LOGIN."""
import asyncio
import json

import pytest
from websockets.utils import accept_key

from hoga.live import kiwoom_ws_client as M, provider_errors
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick


async def until(predicate):
    for _ in range(300):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate()


class Socket:
    def __init__(self, *, missing=None, hang_close=False):
        self.missing = missing
        self.hang_close = hang_close
        self.incoming = asyncio.Queue()
        self.sent = []
        self.receiver_active = False
        self.terminated = asyncio.Event()
        self.close_entered = asyncio.Event()
        self.close_release = asyncio.Event()
        self.aborts = 0

    async def recv(self):
        assert not self.receiver_active
        self.receiver_active = True
        try:
            return await self.incoming.get()
        finally:
            self.receiver_active = False

    async def send(self, raw):
        msg = json.loads(raw)
        self.sent.append(msg)
        if msg.get('trnm') != self.missing:
            self.push(trnm=msg['trnm'], return_code=0)

    async def close(self):
        self.close_entered.set()
        if self.hang_close:
            await self.close_release.wait()
        self.terminated.set()

    async def abort(self):
        self.aborts += 1
        self.terminated.set()

    def push(self, **msg):
        self.incoming.put_nowait(json.dumps(msg))


@pytest.fixture(autouse=True)
def no_pacing(monkeypatch):
    monkeypatch.setattr(M, '_REG_PACING_S', 0)
    monkeypatch.setattr(M, '_BACKOFF_S', (0,))


def client(connect, consume=None, **kwargs):
    return M.KiwoomWsClient(token_fn=lambda: asyncio.sleep(0, result='SECRET'),
                           on_tick=consume, date_fn=lambda: '20261002', _connect=connect, **kwargs)


async def stop(*tasks):
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_external_remove_timeout_joins_receiver_and_consumer_before_reconnect(monkeypatch):
    sockets = [Socket(missing='REMOVE', hang_close=True), Socket()]
    calls, ticks = [], []
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def connect(_url):
        if calls:
            assert sockets[0].terminated.is_set()
            assert not sockets[0].receiver_active
            assert cancelled.is_set()
        calls.append(1)
        return sockets[len(calls) - 1]

    async def consume(tick):
        ticks.append(tick.payload['sequence'])
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    monkeypatch.setattr(M, 'parse_real_message', lambda msg, **kw: [
        WsTick('000660', kw['now_ms'], SnapshotKind.TRADE, {'sequence': n}) for n in msg['data']
    ])
    instance = client(connect, consume, account_id=2)
    runner = asyncio.create_task(instance.run(['005930', '000660']))
    try:
        await until(lambda: instance.registration_ready)
        sockets[0].push(trnm='REAL', data=[1, 2])
        await until(entered.is_set)
        sockets[0].push(trnm='REAL', data=[3])
        await until(lambda: instance.data_queue_snapshot()['depth'] == 1)
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        with pytest.raises(TimeoutError):
            await instance.update_codes(['000660'])
        # Restore normal ACK deadlines for the replacement session.
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 10)
        await until(sockets[0].close_entered.is_set)
        failure = next(f for f in provider_errors.failures() if f.account_id == 2)
        assert failure.phase == 'REMOVE' and failure.connection_generation == 1
        assert calls == [1]  # no replacement before transport termination
        assert not instance._ack_waiters and ticks == [1]
        assert instance.data_queue_snapshot()['discarded_messages'] == 2
        assert instance.data_queue_snapshot()['depth'] == 0
        sockets[0].push(trnm='REG', return_code=0)  # late ACK cannot enter new generation
        sockets[0].push(trnm='REAL', data=[4])
        sockets[0].close_release.set()
        await until(lambda: instance.connection_generation == 2 and instance.registration_ready)
        assert ticks == [1]
        assert instance.expected_codes == instance._acked == {'000660'}
        assert len(calls) == 2
        assert not any(f.account_id == 2 for f in provider_errors.failures())
    finally:
        sockets[0].close_release.set()
        await stop(runner)


@pytest.mark.parametrize('missing', ['LOGIN', 'REG'])
async def test_initial_control_timeout_uses_same_owner_cleanup(monkeypatch, missing):
    socket = Socket(missing=missing)
    instance = client(lambda _: asyncio.sleep(0, result=socket), on_vi_row=lambda *_: None)
    instance._codes = ['005930']
    monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
    with pytest.raises(TimeoutError):
        await instance._session_once()
    assert socket.terminated.is_set() and not socket.receiver_active
    assert not instance.connected and not instance._ack_waiters and instance._retired is None


async def test_hanging_close_requires_abort_before_reconnect(monkeypatch):
    sockets = [Socket(missing='REMOVE', hang_close=True), Socket()]
    calls = []

    async def connect(_):
        if calls:
            assert sockets[0].terminated.is_set() and sockets[0].aborts == 1
        calls.append(1)
        return sockets[len(calls) - 1]

    instance = client(connect)
    runner = asyncio.create_task(instance.run(['005930']))
    try:
        await until(lambda: instance.registration_ready)
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        monkeypatch.setattr(M, '_CLOSE_TIMEOUT_S', 0)
        monkeypatch.setattr(M, '_CLOSE_GRACE_S', 0)
        with pytest.raises(TimeoutError):
            await instance.update_codes([])
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 10)
        await until(lambda: instance.connection_generation == 2 and instance.registration_ready)
        assert len(calls) == 2
    finally:
        await stop(runner)


async def test_unknown_termination_blocks_replacement_until_shutdown(monkeypatch):
    socket = Socket(missing='REMOVE', hang_close=True)
    socket.abort = None
    calls = []

    async def connect(_):
        calls.append(1)
        return socket

    instance = client(connect)
    runner = asyncio.create_task(instance.run(['005930']))
    try:
        await until(lambda: instance.registration_ready)
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        monkeypatch.setattr(M, '_CLOSE_TIMEOUT_S', 0)
        monkeypatch.setattr(M, '_CLOSE_GRACE_S', 0)
        with pytest.raises(TimeoutError):
            await instance.update_codes([])
        await until(socket.close_entered.is_set)
        for _ in range(100):
            await asyncio.sleep(0)
        assert calls == [1] and not runner.done() and not instance.connected
    finally:
        await stop(runner)


async def test_control_evidence_is_bounded_and_never_retains_vendor_text(caplog):
    socket = Socket()
    instance = client(lambda _: asyncio.sleep(0, result=socket))
    instance._ws = socket
    for _ in range(60):
        await instance._dispatch_control({'trnm': 'SECRET', 'return_code': 'SECRET',
                                          'return_msg': 'SECRET'}, 'SECRET')
    instance._retire(socket, TimeoutError())
    assert len(instance._control_events) == 32
    assert all(e['stage'] == 'ack_orphan' and e['trnm'] == 'other' for e in instance._control_events)
    assert 'SECRET' not in json.dumps(list(instance._control_events))
    assert 'SECRET' not in caplog.text


async def test_retired_socket_cannot_send_controls_to_replacement():
    old, new = Socket(), Socket()
    instance = client(None)
    instance._ws = new
    with pytest.raises(ConnectionError):
        await instance._send_and_wait(old, '{"trnm":"REG"}', 'REG')
    assert not old.sent and not new.sent and not instance._ack_waiters


async def test_rejected_remove_does_not_claim_new_registration_ready(monkeypatch):
    socket = Socket()
    instance = client(lambda _: asyncio.sleep(0, result=socket))
    runner = asyncio.create_task(instance.run(['005930', '000660']))
    try:
        await until(lambda: instance.registration_ready)
        original = socket.send

        async def reject_remove(raw):
            if json.loads(raw).get('trnm') == 'REMOVE':
                socket.push(trnm='REMOVE', return_code=105115)
            else:
                await original(raw)

        socket.send = reject_remove
        monkeypatch.setattr(M, '_BACKOFF_S', (60,))
        with pytest.raises(M.KiwoomSlotCapReached):
            await instance.update_codes(['000660'])
        assert not instance.registration_ready and instance._retired.is_set()
        assert instance._retiring_failure._kiwoom_phase == 'REMOVE'
        await until(socket.terminated.is_set)
    finally:
        await stop(runner)


async def test_shutdown_during_close_aborts_and_does_not_reconnect(monkeypatch):
    socket = Socket(missing='REMOVE', hang_close=True)
    calls = []

    async def connect(_):
        calls.append(1)
        return socket

    instance = client(connect)
    runner = asyncio.create_task(instance.run(['005930']))
    try:
        await until(lambda: instance.registration_ready)
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        with pytest.raises(TimeoutError):
            await instance.update_codes([])
        await until(socket.close_entered.is_set)
        await stop(runner)
        assert calls == [1] and socket.aborts == 1 and socket.terminated.is_set()
        assert not instance._ack_waiters and instance._retired is None
    finally:
        await stop(runner)


async def test_control_send_backpressure_is_bounded(monkeypatch):
    socket = Socket()
    instance = client(None)
    instance._ws = socket
    instance._retired = asyncio.Event()

    async def blocked_send(_):
        await asyncio.Event().wait()

    socket.send = blocked_send
    monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
    with pytest.raises(TimeoutError):
        await instance._send_and_wait(socket, '{"trnm":"REG"}', 'REG')
    assert instance._retired.is_set() and not instance._ack_waiters
    assert instance._retiring_failure._kiwoom_phase == 'REG'


async def test_retiring_one_account_leaves_other_five_receivers_running(monkeypatch):
    sockets = [Socket(missing='REMOVE', hang_close=True) for _ in range(6)]
    instances = [client(lambda _, socket=socket: asyncio.sleep(0, result=socket), account_id=i)
                 for i, socket in enumerate(sockets)]
    runners = [asyncio.create_task(instance.run(['005930'])) for instance in instances]
    try:
        await until(lambda: all(instance.registration_ready for instance in instances))
        monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        with pytest.raises(TimeoutError):
            await instances[0].update_codes([])
        await until(sockets[0].close_entered.is_set)
        assert all(instance.registration_ready for instance in instances[1:])
        assert all(socket.receiver_active for socket in sockets[1:])
        assert all(instance.connection_generation == 1 for instance in instances)
    finally:
        for socket in sockets:
            socket.close_release.set()
        await stop(*runners)


async def test_loopback_peer_without_close_reply_is_terminated(monkeypatch):
    # Minimal RFC6455 peer: handshake OK, then consume without answering CLOSE.
    accepted = asyncio.Event()
    terminated = asyncio.Event()

    async def peer(reader, writer):
        try:
            request = await reader.readuntil(b'\r\n\r\n')
            key = next(line.split(':', 1)[1].strip() for line in request.decode().splitlines()
                       if line.lower().startswith('sec-websocket-key:'))
            writer.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n'
                          'Connection: Upgrade\r\nSec-WebSocket-Accept: '
                          + accept_key(key) + '\r\n\r\n').encode())
            await writer.drain()
            accepted.set()
            while await reader.read(4096):
                pass
        finally:
            writer.close()
            await writer.wait_closed()
            terminated.set()

    monkeypatch.setattr(M, '_CLOSE_TIMEOUT_S', 0.01)
    monkeypatch.setattr(M, '_CLOSE_GRACE_S', 0)  # exercise the original equal-deadline race
    server = await asyncio.start_server(peer, '127.0.0.1', 0)
    try:
        port = server.sockets[0].getsockname()[1]
        socket = await M.KiwoomWsClient._default_connect(f'ws://127.0.0.1:{port}')
        await accepted.wait()
        instance = client(None)
        await instance._safe_close(socket)
        assert socket.connection.connection_lost_waiter.done()
        async with asyncio.timeout(2):
            await terminated.wait()
    finally:
        server.close()
        await server.wait_closed()
