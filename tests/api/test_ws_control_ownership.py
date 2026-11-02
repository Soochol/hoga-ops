import asyncio
from types import SimpleNamespace

import anyio
import pytest
from starlette.websockets import WebSocketDisconnect

from hoga.api.events import EventBus
from hoga.api.ws import build_ws_router
from hoga.live.buffer import LiveBuffer


class Socket:
    def __init__(self, messages):
        self.messages = iter(messages)
        self.received = 0
        self.frames = []
        self.disconnected = asyncio.Event()
        self.closed = None

    async def accept(self):
        pass

    async def receive_json(self):
        message = next(self.messages, None)
        if message is not None:
            self.received += 1
            return message
        await self.disconnected.wait()
        raise WebSocketDisconnect()

    async def send_json(self, frame):
        self.frames.append(frame)

    async def close(self, *, code, reason):
        self.closed = code, reason


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


async def test_receiver_drains_while_lifecycle_waits_and_preserves_effect_ack_order(monkeypatch):
    from hoga.live import lifecycle

    gate, entered = asyncio.Event(), asyncio.Event()
    effects = []

    async def subscribe(code, venues, *, ref):
        entered.set()
        await gate.wait()
        effects.append(('subscribe', code))
        return True

    async def unsubscribe(code, venues, *, ref):
        effects.append(('unsubscribe', code))

    monkeypatch.setattr(lifecycle, 'on_view_subscribe', subscribe)
    monkeypatch.setattr(lifecycle, 'on_view_unsubscribe', unsubscribe)
    messages = [dict(action='subscribe', code='005930'), dict(action='unsubscribe', code='005930'),
                dict(action='subscribe', code='005930'), dict(action='subscribe', code='00088K')]
    socket = Socket(messages)
    buffer, bus = LiveBuffer(), EventBus()
    task = asyncio.create_task(build_ws_router(bus, lambda: buffer).routes[0].endpoint(socket))
    try:
        await entered.wait()
        await settle()
        assert socket.received == len(messages)
        assert socket.frames == []
        gate.set()
        await settle()
        assert effects == [('subscribe', '005930'), ('unsubscribe', '005930'),
                           ('subscribe', '005930'), ('subscribe', '00088K')]
        assert socket.frames == [dict(ch='subscribed', code=code) for code in ['005930', '005930', '00088K']]
        assert len(buffer._subscribers['005930']) == 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    assert not buffer._subscribers
    assert not bus.queues


async def test_pending_command_overflow_closes_explicitly_without_ack(monkeypatch):
    from hoga.live import lifecycle

    async def subscribe(*args, **kwargs):
        await asyncio.Event().wait()

    monkeypatch.setattr(lifecycle, 'on_view_subscribe', subscribe)
    socket = Socket([dict(action='subscribe', code='005930')] * (3 * (512 + 200) + 2))
    buffer = LiveBuffer()
    task = asyncio.create_task(build_ws_router(EventBus(), lambda: buffer).routes[0].endpoint(socket))
    try:
        await settle()
        assert socket.closed is not None
        assert socket.closed[0] == 1013
        assert socket.frames == []
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_initial_and_complete_replacement_burst_fits_for_both_markets(monkeypatch):
    from hoga.live import lifecycle

    entered, release = asyncio.Event(), asyncio.Event()
    effects = []

    async def subscribe(code, venues, *, ref):
        entered.set()
        await release.wait()
        effects.append(('subscribe', code))
        return True

    async def unsubscribe(code, venues, *, ref):
        effects.append(('unsubscribe', code))

    class Session:
        async def on_us_subscribe(self, exchange, symbol, *, ref):
            effects.append(('subscribe_us_stock', symbol))

        async def on_us_unsubscribe(self, exchange, symbol, *, ref):
            effects.append(('unsubscribe_us_stock', symbol))

        def forget_view_ref(self, ref):
            pass

        def forget_us_ref(self, ref):
            pass

        async def release_us_view(self, ref):
            pass

    monkeypatch.setattr(lifecycle, 'on_view_subscribe', subscribe)
    monkeypatch.setattr(lifecycle, 'on_view_unsubscribe', unsubscribe)
    monkeypatch.setattr(lifecycle._state, 'kiwoom_session', Session())
    domestic = [dict(code=f'{i:06d}') for i in range(512)]
    us = [dict(exchange='NASDAQ', symbol=f'S{i}') for i in range(200)]
    messages = []
    for action in ['subscribe', 'unsubscribe', 'subscribe']:
        messages.extend(dict(action=action, **subject) for subject in domestic)
        messages.extend(dict(action=action + '_us_stock', **subject) for subject in us)
    socket, buffer = Socket(messages), LiveBuffer()
    task = asyncio.create_task(build_ws_router(EventBus(), lambda: buffer).routes[0].endpoint(socket))
    try:
        await entered.wait()
        assert socket.received == 2136
        assert socket.closed is None
        assert socket.frames == []
        release.set()
        await settle()
        expected = [(message['action'], message.get('code', message.get('symbol'))) for message in messages]
        assert effects == expected
        assert len(socket.frames) == 1024
        assert len(buffer._subscribers) == 512
        assert socket.closed is None
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


@pytest.mark.parametrize('message', [[], 'subscribe', 42, {'action': 'subscribe', 'code': 'x' * 10000}])
async def test_malformed_control_does_not_end_connection(monkeypatch, message):
    from hoga.live import lifecycle

    async def subscribe(*args, **kwargs):
        return True

    monkeypatch.setattr(lifecycle, 'on_view_subscribe', subscribe)
    socket = Socket([message, dict(action='subscribe', code='Q123456')])
    buffer = LiveBuffer()
    task = asyncio.create_task(build_ws_router(EventBus(), lambda: buffer).routes[0].endpoint(socket))
    try:
        await settle()
        assert socket.frames == [dict(ch='subscribed', code='Q123456')]
        assert not task.done()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


def actual_session(monkeypatch, tmp_path, mode, call):
    from hoga.live.collector_process import CaptureProcessSession
    from hoga.live.kiwoom_session import KiwoomSessionManager, _DisplayEntry

    if mode == 'process':
        session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
        session.views[('005930', 'other-tab')] = {'KRX'}
        session.peer = SimpleNamespace(call=call, closed=asyncio.Event())
        monkeypatch.setattr(session, 'alive', lambda: True)
        lock = session.lock

        def refs():
            return {key[1] for key in session.views}
    else:
        session = KiwoomSessionManager(buffer=LiveBuffer(), data_dir=tmp_path,
            date_fn=lambda: '20261102', nxt_map_fn=lambda: {})
        session._display[('005930', 'KRX')] = _DisplayEntry(refs={'other-tab'})
        session._conns[0] = object()
        monkeypatch.setattr(session, '_pick_account', lambda: 0)
        monkeypatch.setattr(session, '_reconcile', call)
        lock = session._lock

        def refs():
            return set(session._display[('005930', 'KRX')].refs)
    return session, lock, refs


@pytest.mark.parametrize('mode', ['process', 'inprocess'])
@pytest.mark.parametrize('stage', ['lock', 'effect', 'unsubscribe-lock'])
async def test_asgi_cancellation_during_actual_session_work_removes_only_owned_refs(monkeypatch, tmp_path, mode, stage):
    from hoga.live import lifecycle

    entered = asyncio.Event()

    async def call(*args, **kwargs):
        if stage == 'unsubscribe-lock':
            return True
        entered.set()
        await asyncio.Event().wait()

    session, lock, refs = actual_session(monkeypatch, tmp_path, mode, call)
    monkeypatch.setattr(lifecycle._state, 'kiwoom_session', session)
    buffer, bus = LiveBuffer(), EventBus()
    messages = [dict(action='subscribe', code='005930', venues=['KRX'])]
    if stage == 'unsubscribe-lock':
        original = lifecycle.on_view_unsubscribe

        async def unsubscribe(code, venues, *, ref):
            async with lock:
                entered.set()
                await original(code, venues, ref=ref)

        monkeypatch.setattr(lifecycle, 'on_view_unsubscribe', unsubscribe)
        messages.append(dict(action='unsubscribe', code='005930'))
    socket = Socket(messages)
    endpoint = build_ws_router(bus, lambda: buffer).routes[0].endpoint
    if stage == 'lock':
        await lock.acquire()
    try:
        async with anyio.create_task_group() as group:
            group.start_soon(endpoint, socket)
            if stage != 'lock':
                await entered.wait()
                assert len(refs()) == 2
            else:
                await settle()
                assert socket.received == 1
                assert refs() == {'other-tab'}
            group.cancel_scope.cancel()
    finally:
        if stage == 'lock':
            lock.release()
    assert refs() == {'other-tab'}
    assert not buffer._subscribers
    assert not bus.queues


async def test_asgi_cancellation_while_actual_us_unsubscribe_waits_for_lock(monkeypatch, tmp_path):
    from hoga.live import lifecycle

    async def noop(*args, **kwargs):
        pass

    session, lock, _ = actual_session(monkeypatch, tmp_path, 'inprocess', noop)
    session._us_refs.add(('NASDAQ', 'AAPL', 'other-tab'))
    monkeypatch.setattr(session, 'sync', noop)
    monkeypatch.setattr(session._us, 'publish', lambda event: None)
    entered = asyncio.Event()
    original = session.on_us_unsubscribe

    async def unsubscribe(exchange, symbol, *, ref):
        async with lock:
            entered.set()
            await original(exchange, symbol, ref=ref)

    monkeypatch.setattr(session, 'on_us_unsubscribe', unsubscribe)
    monkeypatch.setattr(lifecycle._state, 'kiwoom_session', session)
    socket = Socket([dict(action=action, exchange='NASDAQ', symbol='AAPL')
                     for action in ['subscribe_us_stock', 'unsubscribe_us_stock']])
    buffer = LiveBuffer()
    endpoint = build_ws_router(EventBus(), lambda: buffer).routes[0].endpoint
    async with anyio.create_task_group() as group:
        group.start_soon(endpoint, socket)
        await entered.wait()
        assert len(session._us_refs) == 2
        group.cancel_scope.cancel()
    assert session._us_refs == {('NASDAQ', 'AAPL', 'other-tab')}


@pytest.fixture
async def collector_rpc(monkeypatch, tmp_path):
    import socket as sockets

    from hoga.api import symbols
    from hoga.live import lifecycle, session_gate
    from hoga.live.collector_ipc import RpcPeer, open_channel
    from hoga.live.collector_process import CaptureProcessSession
    from hoga.live.collector_worker import CollectorWorker
    from hoga.live.kiwoom_diagnostics import configure_failure_context

    monkeypatch.setattr(symbols, 'nxt_enabled_by_code', lambda: {})
    monkeypatch.setattr(session_gate, 'is_trading_day_now', lambda _: True)
    parent_socket, child_socket = sockets.socketpair()
    parent_peer = RpcPeer(*(await open_channel(parent_socket)), 'test')
    child_peer = RpcPeer(*(await open_channel(child_socket)), 'test')
    buffer = LiveBuffer()
    owner = CaptureProcessSession(buffer=buffer, data_dir=tmp_path)
    owner.peer = parent_peer
    owner.process = SimpleNamespace(pid=123)
    monkeypatch.setattr(owner, 'alive', lambda: True)
    monkeypatch.setattr(owner, '_health', lambda: ('ready', True))
    monkeypatch.setattr(lifecycle._state, 'kiwoom_session', owner)
    worker = CollectorWorker(tmp_path, 'test', child_peer)
    entered, applied = asyncio.Event(), asyncio.Event()

    async def dispatch():
        while True:
            command = await child_peer.commands.get()
            if command['method'] == 'view_subscribe' and command['args']['ref'] != 'other-tab':
                entered.set()
            if command['method'] == 'sync' and any(ref[2] != 'other-tab' for ref in command['args']['us_refs']):
                entered.set()
            result = await worker.command(command['method'], command['args'])
            if entered.is_set():
                applied.set()
            await child_peer.reply(command, result=result)

    readers = [asyncio.create_task(parent_peer.read()), asyncio.create_task(child_peer.read()),
               asyncio.create_task(dispatch())]
    try:
        yield owner, worker, entered, applied
    finally:
        if worker.manager._lock.locked():
            worker.manager._lock.release()
        for task in readers:
            task.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        await worker.manager.stop()
        configure_failure_context(None)
        for peer in (parent_peer, child_peer):
            peer.writer.close()
            await peer.writer.wait_closed()


@pytest.mark.parametrize('market', ['domestic', 'us'])
async def test_watchdog_removes_late_child_subscription_after_ws_cancellation(collector_rpc, market):
    owner, worker, entered, applied = collector_rpc
    buffer = owner.buffer
    try:
        await owner.on_view_subscribe('005930', {'KRX'}, ref='other-tab')
        await owner.on_us_subscribe('NASDAQ', 'AAPL', ref='other-tab')
        await owner.sync((), n_accounts=0)
        baseline_version = owner.version
        await worker.manager._lock.acquire()
        message = (dict(action='subscribe', code='005930', venues=['KRX']) if market == 'domestic'
                   else dict(action='subscribe_us_stock', exchange='NASDAQ', symbol='AAPL'))
        socket = Socket([message])
        async with anyio.create_task_group() as group:
            group.start_soon(build_ws_router(EventBus(), lambda: buffer).routes[0].endpoint, socket)
            await entered.wait()
            group.cancel_scope.cancel()
        assert owner.views == {('005930', 'other-tab'): {'KRX'}}
        assert owner.us_refs == {('NASDAQ', 'AAPL', 'other-tab')}
        worker.manager._lock.release()
        await applied.wait()
        assert len(worker.views if market == 'domestic' else worker.manager._us_refs) == 2
        await owner.watchdog_pass(0)
        assert worker.views == {('005930', 'other-tab'): {'KRX'}}
        assert worker.manager._display[('005930', 'KRX')].refs == {'other-tab'}
        assert worker.manager._us_refs == {('NASDAQ', 'AAPL', 'other-tab')}
        expected_version = baseline_version + (1 if market == 'domestic' else 2)
        assert owner.version == expected_version
        await owner.watchdog_pass(0)
        assert owner.version == expected_version
    finally:
        if worker.manager._lock.locked():
            worker.manager._lock.release()


@pytest.mark.parametrize('market', ['domestic', 'us'])
async def test_forget_reconciles_child_refs_even_when_parent_ref_is_already_absent(collector_rpc, market):
    owner, worker, _, _ = collector_rpc
    await owner.on_view_subscribe('005930', {'KRX'}, ref='other-tab')
    await owner.on_us_subscribe('NASDAQ', 'AAPL', ref='other-tab')
    await owner.sync((), n_accounts=0)
    if market == 'domestic':
        await worker.command('view_subscribe', {'code': '005930', 'venues': ['KRX'], 'ref': 'closed-tab'})
        owner.forget_view_ref('closed-tab')
    else:
        worker.manager._us_refs.add(('NASDAQ', 'AAPL', 'closed-tab'))
        owner.forget_us_ref('closed-tab')
    await owner.watchdog_pass(0)
    assert worker.views == {('005930', 'other-tab'): {'KRX'}}
    assert worker.manager._display[('005930', 'KRX')].refs == {'other-tab'}
    assert worker.manager._us_refs == {('NASDAQ', 'AAPL', 'other-tab')}


@pytest.mark.parametrize('market', ['domestic', 'us'])
@pytest.mark.parametrize('stage', ['configuration', 'ack'])
async def test_release_during_sync_requires_one_followup_before_fast_path(collector_rpc, monkeypatch, market, stage):
    owner, worker, _, _ = collector_rpc
    await owner.on_view_subscribe('005930', {'KRX'}, ref='other-tab')
    await owner.on_us_subscribe('NASDAQ', 'AAPL', ref='other-tab')
    await owner.sync((), n_accounts=0)
    baseline_version = owner.version
    entered, release = asyncio.Event(), asyncio.Event()
    if stage == 'configuration':
        original = owner._configuration

        async def configuration(*args):
            entered.set()
            await release.wait()
            return await original(*args)

        monkeypatch.setattr(owner, '_configuration', configuration)
    else:
        original = worker.synchronize

        async def synchronize(args):
            result = await original(args)
            entered.set()
            await release.wait()
            return result

        monkeypatch.setattr(worker, 'synchronize', synchronize)
    forget = owner.forget_view_ref if market == 'domestic' else owner.forget_us_ref
    forget('previously-closed-tab')
    syncing = asyncio.create_task(owner.sync((), n_accounts=0))
    try:
        await entered.wait()
        forget('closed-during-sync')
        release.set()
        await syncing
        await owner.watchdog_pass(0)
        assert owner.version == baseline_version + 2
        await owner.watchdog_pass(0)
        assert owner.version == baseline_version + 2
        assert worker.views == {('005930', 'other-tab'): {'KRX'}}
        assert worker.manager._us_refs == {('NASDAQ', 'AAPL', 'other-tab')}
    finally:
        release.set()
        syncing.cancel()
        await asyncio.gather(syncing, return_exceptions=True)
