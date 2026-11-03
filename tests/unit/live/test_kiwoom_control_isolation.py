import asyncio
import json
import os

import pytest

from hoga.live import kiwoom_ws_client as M, provider_errors
from hoga.live.kiwoom_diagnostics import configure_failure_context
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick


class QueueSocket:
    def __init__(self):
        self.incoming = asyncio.Queue()
        self.sent = []
        self.closed = False

    async def recv(self):
        item = await self.incoming.get()
        if isinstance(item, Exception):
            raise item
        return item

    async def send(self, raw):
        self.sent.append(json.loads(raw))

    async def close(self):
        self.closed = True

    def push(self, **message):
        self.incoming.put_nowait(json.dumps(message))


def client(ws, on_tick=None, **kwargs):
    instance = M.KiwoomWsClient(
        token_fn=lambda: asyncio.sleep(0, result="SECRET"), on_tick=on_tick,
        date_fn=lambda: "20261001", _connect=lambda url: asyncio.sleep(0, result=ws), **kwargs,
    )
    instance._ws = ws
    return instance


async def until(predicate):
    for _ in range(100):
        if predicate():
            return
        await asyncio.sleep(0)
    assert predicate()


@pytest.fixture
def parse(monkeypatch):
    monkeypatch.setattr(M, "parse_real_message", lambda msg, **kw: [
        WsTick("005930", kw["now_ms"], SnapshotKind.TRADE, {"sequence": row}) for row in msg["data"]
    ])


async def test_reg_and_ping_are_handled_while_tick_callback_waits(parse):
    ws = QueueSocket()
    entered, release = asyncio.Event(), asyncio.Event()
    received = []

    async def consume(tick):
        received.append(tick.payload["sequence"])
        entered.set()
        await release.wait()

    instance = client(ws, consume)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    ws.push(trnm="REAL", data=[1, 2])
    sender = None
    try:
        await until(entered.is_set)
        sender = asyncio.create_task(instance._send_and_wait(ws, '{"trnm":"REG"}', "REG"))
        await until(lambda: "REG" in instance._ack_waiters)
        ws.push(trnm="REG", return_code=0)
        ws.push(trnm="PING")
        await until(lambda: sender.done() and {"trnm": "PING"} in ws.sent)
        assert (await sender)["return_code"] == 0
        assert received == [1]
        ws.push(trnm="REAL", data=[3])
        release.set()
        await until(lambda: received == [1, 2, 3])
    finally:
        receiver.cancel()
        if sender is not None:
            sender.cancel()
        await asyncio.gather(receiver, *([sender] if sender else []), return_exceptions=True)


async def test_callback_suspensions_do_not_add_an_extra_consumer_yield(parse):
    clock = [0.0]
    received = []

    async def consume(tick):
        await asyncio.sleep(0)
        clock[0] += 0.010  # queue/scheduler wait exceeds the 1ms work budget
        received.append(tick.payload['sequence'])

    ws = QueueSocket()
    instance = client(ws, consume, monotonic_fn=lambda: clock[0])
    receiver = asyncio.create_task(instance._recv_loop(ws))
    try:
        ws.push(trnm='REAL', data=list(range(16)))
        ws.push(trnm='PING')
        await until(lambda: len(received) == 16 and {'trnm': 'PING'} in ws.sent)
        assert received == list(range(16))
        assert instance._consumer_budget.yields == 0
        assert instance._consumer_budget.observed_resumes >= 16
        assert instance.data_queue_snapshot()['overflows'] == 0
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_backlog_evidence_survives_queue_cleanup_and_contains_no_payload(parse, monkeypatch, caplog):
    monkeypatch.setattr(M, '_DATA_QUEUE_MAX_MESSAGES', 2)
    clock = [0.0]
    ws = QueueSocket()
    entered = asyncio.Event()

    async def consume(_tick):
        entered.set()
        await asyncio.Event().wait()

    instance = client(ws, consume, account_id=3, monotonic_fn=lambda: clock[0])
    instance.connection_generation = 7
    configure_failure_context(lambda: {'commit': 'a' * 40, 'live_started_at_ms': 123,
                                      'gc': {'by_generation': {'1': {'max_ms': 456}}}})
    receiver = asyncio.create_task(instance._recv_loop(ws))
    try:
        ws.push(trnm='REAL', data=[0], unused_secret='DO_NOT_LOG_THIS')
        await until(entered.is_set)
        clock[0] = 2.0
        for sequence in (1, 2, 3):
            ws.push(trnm='REAL', data=[sequence], unused_secret='DO_NOT_LOG_THIS')
        await until(receiver.done)
        with pytest.raises(M.KiwoomDataBacklogError) as caught:
            await receiver
        evidence = caught.value._kiwoom_backlog_evidence
        assert evidence['pid'] == os.getpid()
        assert evidence['connection_generation'] == 7
        assert evidence['account_id'] == 3
        assert evidence['runtime']['live_started_at_ms'] == 123
        assert evidence['runtime']['gc']['by_generation']['1']['max_ms'] == 456
        assert evidence['queue_depth'] == 2  # failure point, before drain
        assert evidence['flow']['received_frames'] == 4
        assert evidence['flow']['completed_frames'] == 0
        assert evidence['flow']['inflight_age_ms'] == 2000
        assert instance.data_queue_snapshot()['depth'] == 0
        assert 'DO_NOT_LOG_THIS' not in caplog.text
        assert 'DO_NOT_LOG_THIS' not in json.dumps(evidence)
        assert '"commit":"' + 'a' * 40 + '"' in caplog.text
    finally:
        configure_failure_context(None)
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_receive_task_creation_is_bounded_by_session_not_frames():
    ws = QueueSocket()
    instance = client(ws)
    loop = asyncio.get_running_loop()
    previous = loop.get_task_factory()
    created = []

    def factory(loop, coro, **kwargs):
        task = asyncio.Task(coro, loop=loop, **kwargs)
        created.append(task)
        return task

    loop.set_task_factory(factory)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    try:
        for _ in range(40):
            ws.push(trnm="PING")
        await until(lambda: len(ws.sent) == 40)
        assert len(created) <= 3
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)
        loop.set_task_factory(previous)
    assert all(task.done() for task in created)


async def test_immediate_overflow_does_not_reuse_previous_session_budgets(monkeypatch):
    monkeypatch.setattr(M, '_DATA_QUEUE_MAX_BYTES', 1)
    ws = QueueSocket()
    instance = client(ws)
    with M.LoopWorkBudget(1) as old_budget:
        instance._reader_budget = instance._consumer_budget = old_budget
        ws.push(trnm='REAL', data=[])
        with pytest.raises(M.KiwoomDataBacklogError) as caught:
            await instance._recv_loop(ws)
    evidence = caught.value._kiwoom_backlog_evidence
    assert evidence['consumer_budget'] is None  # It had not started at the failure point.
    assert evidence['flow']['received_frames'] == 1
    assert instance._reader_budget is not old_budget


async def test_fast_burst_gives_consumer_a_turn_before_declaring_overload(parse):
    ws = QueueSocket()
    received = []

    async def consume(tick):
        received.append(tick.payload["sequence"])

    instance = client(ws, consume, tick_yield_interval_s=1000)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    try:
        for sequence in range(1000):
            ws.push(trnm="REAL", data=[sequence])
        await until(lambda: len(received) == 1000 or receiver.done())
        assert received == list(range(1000))
        assert instance.data_queue_snapshot()["overflows"] == 0
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_multi_tick_catchup_preserves_order_and_following_controls(parse):
    ws = QueueSocket()
    received = []

    async def consume(tick):
        received.append(tick.payload["sequence"])
        await asyncio.sleep(0)  # model the yielding work inside a multi-tick frame

    instance = client(ws, consume, tick_yield_interval_s=1000)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    waiter = asyncio.get_running_loop().create_future()
    instance._ack_waiters["REG"] = waiter
    try:
        for start in range(0, 1024, 8):
            ws.push(trnm="REAL", data=list(range(start, start + 8)))
        ws.push(trnm="REG", return_code=0)
        ws.push(trnm="PING")
        # Scheduler turns, rather than wall-clock performance assertions.
        for _ in range(1100):
            if len(received) == 1024 or receiver.done():
                break
            await asyncio.sleep(0)
        assert received == list(range(1024))
        assert waiter.done() and (await waiter)["return_code"] == 0
        assert {"trnm": "PING"} in ws.sent
        assert instance.data_queue_snapshot()["overflows"] == 0
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_seconds_preparation_allows_real_and_control_progress(tmp_path, monkeypatch, parse):
    from hoga.live.second_trade_agg import SecondTradeBar
    from hoga.live.second_trade_store import SecondTradeStore

    store = SecondTradeStore(tmp_path)
    t_ms = 1790812800000
    store._sealed_before = t_ms - 1000
    for i in range(512):
        store.ingest(WsTick(f"{i:06}", t_ms, SnapshotKind.TRADE,
                            {"trades": [{"t_ms": t_ms, "price": 100, "qty": 2, "side": 1}]}))
    preparing = asyncio.Event()
    calls = 0
    original = SecondTradeBar.record

    def record(bar):
        nonlocal calls
        calls += 1
        preparing.set()
        return original(bar)

    monkeypatch.setattr(SecondTradeBar, "record", record)
    received, progress = [], []

    async def consume(tick):
        received.append(tick.payload["sequence"])
        progress.append(calls)

    ws = QueueSocket()
    instance = client(ws, consume, tick_yield_interval_s=1000)
    waiter = asyncio.get_running_loop().create_future()
    instance._ack_waiters["REG"] = waiter
    receiver = asyncio.create_task(instance._recv_loop(ws))
    flush = asyncio.create_task(store.flush(now_ms=t_ms + 5000))
    try:
        await preparing.wait()
        ws.push(trnm="REAL", data=[1, 2])
        ws.push(trnm="REG", return_code=0)
        ws.push(trnm="PING")
        await flush
        await until(lambda: received == [1, 2] and {"trnm": "PING"} in ws.sent)
        assert all(0 < value < calls for value in progress)
        assert waiter.done() and (await waiter)["return_code"] == 0
        assert instance.data_queue_snapshot()["overflows"] == 0
    finally:
        receiver.cancel()
        flush.cancel()
        await asyncio.gather(receiver, flush, return_exceptions=True)


async def test_ack_timing_excludes_socket_close_and_failure_is_scoped(monkeypatch):
    ws = QueueSocket()
    clock = [0.0]
    instance = client(ws, account_id=2, monotonic_fn=lambda: clock[0])
    instance.connection_generation = 7
    generation = provider_errors.begin(instance, "session")
    instance._error_generation = generation
    instance._retired = asyncio.Event()
    monkeypatch.setattr(M, "_ACK_TIMEOUT_S", 0)
    task = asyncio.create_task(instance._send_and_wait(ws, "{}", "REG"))
    try:
        with pytest.raises(TimeoutError):
            await task
        assert instance.control_latency["REG"].snapshot()["max_ms"] == 0
        failure = next(f for f in provider_errors.failures() if f.account_id == 2)
        assert failure.phase == "REG"
        assert failure.connection_generation == 7
        assert failure.elapsed_ms == 0
        assert "SECRET" not in failure.model_dump_json()
        assert instance._retired.is_set()
        assert "close" not in instance.control_latency  # only the session owner closes
        assert not ws.closed
    finally:
        await asyncio.gather(task, return_exceptions=True)
        provider_errors.clear(instance)


async def test_data_queue_overflow_is_explicit_and_cancels_consumer(parse, monkeypatch):
    monkeypatch.setattr(M, "_DATA_QUEUE_MAX_MESSAGES", 2)
    entered, cancelled = asyncio.Event(), asyncio.Event()

    async def consume(tick):
        entered.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    ws = QueueSocket()
    instance = client(ws, consume)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    ws.push(trnm="REAL", data=[0])
    try:
        await until(entered.is_set)
        retired_queue = instance._data_queue
        for sequence in (1, 2, 3):
            ws.push(trnm="REAL", data=[sequence])
        await until(receiver.done)
        with pytest.raises(M.KiwoomDataBacklogError) as caught:
            await receiver
        assert cancelled.is_set()
        assert caught.value._kiwoom_phase == "dispatch"
        snapshot = instance.data_queue_snapshot()
        assert snapshot["overflows"] == 1
        assert snapshot["discarded_messages"] == 4
        assert snapshot["depth"] == 0
        assert snapshot["bytes"] == 0
        assert retired_queue.empty()
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_data_queue_byte_limit_rejects_a_single_oversized_message(monkeypatch):
    monkeypatch.setattr(M, "_DATA_QUEUE_MAX_BYTES", 16)
    ws = QueueSocket()
    instance = client(ws)
    ws.push(trnm="REAL", data=["x" * 20])
    with pytest.raises(M.KiwoomDataBacklogError):
        await instance._recv_loop(ws)
    assert instance.data_queue_snapshot()["overflows"] == 1


async def test_next_connection_cannot_consume_retired_connections_pending_data(parse):
    first, second = QueueSocket(), QueueSocket()
    entered, release = asyncio.Event(), asyncio.Event()
    received = []

    async def consume(tick):
        received.append(tick.payload["sequence"])
        entered.set()
        await release.wait()

    instance = client(first, consume)
    receiver = asyncio.create_task(instance._recv_loop(first))
    try:
        first.push(trnm="REAL", data=[1])
        await until(entered.is_set)
        first.push(trnm="REAL", data=[99])
        await until(lambda: instance.data_queue_snapshot()["depth"] == 1)
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)
    assert instance.data_queue_snapshot()["discarded_messages"] == 2
    release.set()
    instance._ws = second
    receiver = asyncio.create_task(instance._recv_loop(second))
    try:
        second.push(trnm="REAL", data=[2])
        await until(lambda: received == [1, 2])
        assert instance.data_queue_snapshot()["depth"] == 0
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


@pytest.mark.parametrize("fully_registered", [False, True])
async def test_recovery_observation_waits_for_subscription_readiness(monkeypatch, fully_registered):
    ws = QueueSocket()
    instance = client(ws, account_id=2)
    instance._codes = ["005930", "000660"]
    previous = provider_errors.begin(instance, "session")
    provider_errors.finish(instance, "session", previous, "ws", TimeoutError())
    instance.last_error_type = "TimeoutError"
    instance._error_generation = provider_errors.begin(instance, "session")
    rounds = []

    async def register(ws, codes):
        instance._acked.update(codes if fully_registered or rounds else codes[:1])
        rounds.append(codes)

    monkeypatch.setattr(instance, "_register_all", register)
    ws.push(trnm="LOGIN", return_code=0)
    session = asyncio.create_task(instance._session_once())
    try:
        await until(lambda: instance.connected and instance._registration_finished)
        assert instance.registration_ready is fully_registered
        assert bool([f for f in provider_errors.failures() if f.account_id == 2]) is not fully_registered
        if not fully_registered:
            assert instance.last_error_type == "TimeoutError"
            assert await instance.resubscribe_missing() == 1
            assert instance.registration_ready
            assert not [f for f in provider_errors.failures() if f.account_id == 2]
        assert instance.last_error_type is None
    finally:
        session.cancel()
        await asyncio.gather(session, return_exceptions=True)
        provider_errors.clear(instance)


async def test_data_worker_failure_wakes_receiver_and_ack_waiter(parse):
    async def consume(tick):
        raise ValueError("bad tick")

    ws = QueueSocket()
    instance = client(ws, consume)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    receiver.add_done_callback(instance._receiver_done)
    sender = asyncio.create_task(instance._send_and_wait(ws, "{}", "REG"))
    try:
        await until(lambda: "REG" in instance._ack_waiters)
        ws.push(trnm="REAL", data=[1])
        await until(lambda: receiver.done() and sender.done())
        with pytest.raises(ValueError, match="bad tick") as caught:
            await receiver
        with pytest.raises(ValueError, match="bad tick"):
            await sender
        assert caught.value._kiwoom_phase == "dispatch"
        assert instance.data_queue_snapshot()["discarded_messages"] == 1
        assert not instance._ack_waiters
    finally:
        receiver.cancel()
        sender.cancel()
        await asyncio.gather(receiver, sender, return_exceptions=True)


async def test_receive_failure_preserves_stage_and_cancellation_does_not_record_failure():
    ws = QueueSocket()
    instance = client(ws)
    ws.incoming.put_nowait(ConnectionError("SECRET"))
    with pytest.raises(ConnectionError) as caught:
        await instance._recv_loop(ws)
    assert caught.value._kiwoom_phase == "receive"
    task = asyncio.create_task(instance._recv_loop(ws))
    await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert instance.data_queue_snapshot()["depth"] == 0


async def test_socket_close_has_its_own_deadline(monkeypatch):
    monkeypatch.setattr(M, "_CLOSE_TIMEOUT_S", 0)
    monkeypatch.setattr(M, "_CLOSE_GRACE_S", 0)
    ws = QueueSocket()
    cancelled = asyncio.Event()

    async def never_close():
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    ws.close = never_close
    async def abort():
        ws.closed = True
    ws.abort = abort
    instance = client(ws)
    await instance._safe_close(ws)
    assert cancelled.is_set()
    assert ws.closed
    assert instance.control_latency["close"].count == 1


def assert_ack_order(stages, *, before_send_return=False):
    assert stages['recv_returned'] <= stages['parsed'] <= stages['ack_matched']
    assert stages['ack_matched'] <= stages['future_resolved'] <= stages['sender_resumed']
    if before_send_return:
        assert stages['future_resolved'] < stages['send_returned'] <= stages['sender_resumed']
    else:
        assert stages['send_returned'] <= stages['recv_returned']


async def test_attempt_observes_ack_before_send_returns_and_suspended_callback(parse):
    entered, release_callback, release_send = asyncio.Event(), asyncio.Event(), asyncio.Event()
    clock = [0.0]

    class SuspendedSend(QueueSocket):
        async def send(self, raw):
            await super().send(raw)
            if json.loads(raw)['trnm'] == 'REG':
                self.push(trnm='REG', return_code=0)
                await release_send.wait()

    async def consume(_tick):
        entered.set()
        await release_callback.wait()

    ws = SuspendedSend()
    instance = client(ws, consume, monotonic_fn=lambda: clock[0])
    receiver = asyncio.create_task(instance._recv_loop(ws))
    sender = None
    try:
        ws.push(trnm='REAL', data=[1])
        await until(entered.is_set)
        sender = asyncio.create_task(instance._send_and_wait(ws, '{"trnm":"REG"}', 'REG', item_count=2))
        await until(lambda: instance._control_attempt is not None
                    and 'future_resolved' in instance._control_attempt.stages)
        clock[0] = 2.0
        during = instance._diagnostic_evidence()
        assert during['progress']['consumer']['phase'] == 'callback'
        assert during['progress']['consumer']['age_ms'] == 2000
        assert during['flow']['inflight_age_ms'] == 2000
        assert 'send_returned' not in during['control_attempt']
        assert 'sender_resumed' not in during['control_attempt']
        assert not sender.done()
        release_send.set()
        assert (await sender)['return_code'] == 0
        attempt = instance._diagnostic_evidence()['control_attempt']
        assert_ack_order(attempt, before_send_return=True)
        assert attempt['resolve_to_resume_ms'] == 2000
        assert during['progress']['consumer']['callback_wall']['count'] == 0
        primary = ConnectionError('SECRET endpoint')
        ws.incoming.put_nowait(primary)
        with pytest.raises(ConnectionError) as caught:
            await receiver
        assert caught.value is primary
        saved = instance._failure_evidence
        assert saved.snapshot()['progress']['consumer']['age_ms'] == 2000
        assert saved.snapshot()['failure']['phase'] == 'receive'
        assert instance.data_queue_snapshot()['depth'] == 0
        instance._control_events.clear()
        instance._control_attempt.stages.clear()
        instance._retire(ws, RuntimeError('SECRET wrapper'))
        assert instance._failure_evidence is saved
        assert saved.snapshot()['control_attempt']['future_resolved'] == 0
    finally:
        receiver.cancel()
        if sender is not None:
            sender.cancel()
        await asyncio.gather(receiver, *([sender] if sender else []), return_exceptions=True)


async def test_timeout_captures_overdue_before_delayed_probe_runs(monkeypatch):
    import time

    from hoga.live.kiwoom_diagnostics import LoopLagEvidence

    recorder = LoopLagEvidence(interval_s=0.001)
    probe = asyncio.create_task(recorder.run())
    await asyncio.sleep(0)
    assert recorder.deadline is not None

    class BlockingSend(QueueSocket):
        async def send(self, raw):
            time.sleep(0.005)
            await super().send(raw)

    ws = BlockingSend()
    instance = client(ws)
    configure_failure_context(lambda: {'collector_loop': recorder.snapshot()})
    monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
    try:
        with pytest.raises(TimeoutError) as caught:
            await instance._send_and_wait(ws, '{"trnm":"REG"}', 'REG')
        assert instance._retiring_failure is caught.value
        loop = instance._failure_evidence.snapshot()['runtime']['collector_loop']
        assert loop['state'] == 'active'
        assert loop['pending_overdue_ms'] > 0
        assert loop['samples'] == []
        assert loop['last_observation_age_ms'] is None
        assert instance._failure_evidence.snapshot()['failure']['phase'] == 'REG'
        assert not instance._ack_waiters
    finally:
        configure_failure_context(None)
        probe.cancel()
        await asyncio.gather(probe, return_exceptions=True)
    assert recorder.snapshot()['state'] == 'stopped'


@pytest.mark.parametrize('timeout', [False, True])
async def test_loopback_peer_delayed_and_late_ack_preserve_retirement(timeout, monkeypatch):
    import websockets

    received, acknowledge, sent = asyncio.Event(), asyncio.Event(), asyncio.Event()

    async def peer(socket):
        assert json.loads(await socket.recv())['trnm'] == 'REG'
        received.set()
        await acknowledge.wait()
        await socket.send('{"trnm":"REG","return_code":0}')
        sent.set()
        await socket.wait_closed()

    async with websockets.serve(peer, '127.0.0.1', 0) as server:
        connection = await websockets.connect(f'ws://127.0.0.1:{server.sockets[0].getsockname()[1]}')
        ws = M._Socket(connection)
        instance = client(ws)
        receiver = asyncio.create_task(instance._recv_loop(ws))
        if timeout:
            monkeypatch.setattr(M, '_ACK_TIMEOUT_S', 0)
        sender = asyncio.create_task(instance._send_and_wait(ws, '{"trnm":"REG"}', 'REG', item_count=1))
        try:
            await received.wait()
            if timeout:
                with pytest.raises(TimeoutError) as caught:
                    await sender
                saved = instance._failure_evidence.encoded
                assert instance._retiring_failure is caught.value
            else:
                assert not sender.done()
                assert 'send_returned' in instance._control_attempt.stages
            acknowledge.set()
            await sent.wait()
            if timeout:
                with pytest.raises(TimeoutError) as caught_again:
                    await receiver
                assert caught_again.value is instance._retiring_failure
                with pytest.raises(TimeoutError):
                    await instance._send_and_wait(ws, '{}', 'REG')
                await instance._dispatch_control({'trnm': 'REG', 'return_code': 0}, '{}')
                assert instance._control_events[-1]['stage'] == 'ack_orphan'
                assert instance._failure_evidence.encoded == saved
                assert not instance._ack_waiters
            else:
                assert (await sender)['return_code'] == 0
                stages = instance._control_attempt.stages
                assert_ack_order(stages)
        finally:
            acknowledge.set()
            receiver.cancel()
            sender.cancel()
            await asyncio.gather(receiver, sender, return_exceptions=True)
            await ws.close()


async def test_diagnostic_provider_or_snapshot_failure_cannot_mask_retirement(monkeypatch, caplog):
    ws = QueueSocket()
    instance = client(ws)

    def broken():
        raise RuntimeError('SECRET endpoint')

    configure_failure_context(broken)
    primary = TimeoutError('SECRET token')
    try:
        instance._annotate_failure(primary, 'REG', 4)
        instance._retire(ws, primary)
        assert instance._retiring_failure is primary
        assert instance._failure_evidence.snapshot()['runtime'] == {'runtime_context_error': 'RuntimeError'}
        assert 'SECRET' not in caplog.text
        instance._failure_evidence = None
        monkeypatch.setattr(instance, '_diagnostic_evidence', broken)
        instance._capture_failure(primary)
        assert instance._failure_evidence.snapshot()['diagnostics'] == 'unavailable'
        assert instance._retiring_failure is primary
    finally:
        configure_failure_context(None)


async def test_new_socket_resets_failure_and_progress_without_mutating_old_snapshot():
    first, second = QueueSocket(), QueueSocket()
    instance = client(first)
    first.incoming.put_nowait(ConnectionError('SECRET'))
    with pytest.raises(ConnectionError):
        await instance._recv_loop(first)
    saved = instance._failure_evidence
    encoded = saved.encoded
    instance._connect = lambda url: asyncio.sleep(0, result=second)
    second.push(trnm='LOGIN', return_code=0)
    session = asyncio.create_task(instance._session_once())
    try:
        await until(lambda: instance.connected)
        assert instance._failure_evidence is None
        assert instance._socket_sequence == 1
        assert instance._progress.reader_phase == 'waiting_recv'
        assert instance._progress.consumer_phase == 'inactive'
        assert saved.encoded == encoded
        assert saved.snapshot()['socket_sequence'] == 0
    finally:
        session.cancel()
        await asyncio.gather(session, return_exceptions=True)


async def test_synchronous_login_failure_survives_receiver_startup_and_cleanup():
    primary = OSError(111, 'SECRET endpoint')
    captured = []

    class BrokenSend(QueueSocket):
        async def send(self, _raw):
            raise primary

    ws = BrokenSend()
    instance = client(ws, account_events=True, on_account_row=lambda *_args: asyncio.sleep(0))

    async def account_state(connected, _generation):
        if not connected:
            captured.append(instance._failure_evidence)
            await asyncio.sleep(0)
            assert instance._failure_evidence is captured[0]

    instance._on_account_state = account_state
    with pytest.raises(OSError) as caught:
        await instance._session_once()
    assert caught.value is primary
    assert instance._retiring_failure is primary
    assert instance._failure_evidence is captured[0]
    assert instance._failure_evidence.snapshot()['failure']['phase'] == 'LOGIN'
    assert instance._failure_evidence.snapshot()['control_attempt']['kind'] == 'LOGIN'
    assert ws.closed
    assert not instance._ack_waiters


@pytest.mark.parametrize('first', ['reader', 'consumer'])
async def test_first_task_failure_keeps_its_queue_and_progress_evidence(first, parse):
    clock = [0.0]
    order = []
    reader_error = ConnectionError('SECRET transport')
    consumer_error = ValueError('SECRET callback')

    class FailingReceive(QueueSocket):
        async def recv(self):
            try:
                return await super().recv()
            except ConnectionError:
                clock[0] = 2.0
                order.append('reader')
                raise

    ws = FailingReceive()

    async def consume(_tick):
        clock[0] += 1.0
        order.append('consumer')
        if first == 'consumer':
            ws.incoming.put_nowait(reader_error)
        raise consumer_error

    instance = client(ws, consume, monotonic_fn=lambda: clock[0], tick_yield_interval_s=1000)
    ws.push(trnm='REAL', data=[0])
    if first == 'reader':
        ws.incoming.put_nowait(reader_error)
    with pytest.raises(ConnectionError) as caught:
        await instance._recv_loop(ws)
    assert caught.value is reader_error
    assert order == ([first, 'consumer'] if first == 'reader' else [first, 'reader'])
    saved = instance._failure_evidence
    snap = saved.snapshot()
    assert snap['failure']['phase'] == ('receive' if first == 'reader' else 'dispatch')
    assert snap['failure']['causes'][0]['type'] == ('ConnectionError' if first == 'reader' else 'ValueError')
    assert snap['queue_depth'] == (1 if first == 'reader' else 0)
    assert (snap['queued_bytes_bound'] > 0) == (first == 'reader')
    assert snap['progress']['reader']['phase'] == 'waiting_recv'
    assert snap['progress']['consumer']['phase'] == ('inactive' if first == 'reader' else 'callback')
    assert snap['discarded_messages'] == (0 if first == 'reader' else 1)
    assert snap['flow']['completed_frames'] == snap['flow']['processed_ticks'] == 0
    assert reader_error._kiwoom_phase == 'receive'
    assert reader_error._kiwoom_elapsed_ms == 2000
    assert consumer_error._kiwoom_phase == 'dispatch'
    assert consumer_error._kiwoom_elapsed_ms == 1000
    assert instance.data_queue_snapshot()['depth'] == 0
    assert instance._progress.reader_phase == instance._progress.consumer_phase == 'inactive'
    instance._capture_failure(RuntimeError('SECRET cleanup'))
    assert instance._failure_evidence is saved


@pytest.mark.parametrize('first', ['reader', 'consumer'])
async def test_opposite_task_cancellation_failure_cannot_replace_first_evidence(first, parse):
    entered = asyncio.Event()
    cleanup_failed = asyncio.Event()
    primary = ConnectionError('SECRET receive') if first == 'reader' else ValueError('SECRET callback')

    class CleanupFailureSocket(QueueSocket):
        async def recv(self):
            try:
                return await super().recv()
            except asyncio.CancelledError:
                cleanup_failed.set()
                raise OSError('SECRET reader cleanup') from None

    async def consume(_tick):
        entered.set()
        if first == 'consumer':
            raise primary
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cleanup_failed.set()
            raise RuntimeError('SECRET callback cleanup') from None

    ws = CleanupFailureSocket()
    instance = client(ws, consume)
    receiver = asyncio.create_task(instance._recv_loop(ws))
    ws.push(trnm='REAL', data=[0])
    try:
        await until(entered.is_set)
        if first == 'reader':
            ws.incoming.put_nowait(primary)
        with pytest.raises(type(primary)) as caught:
            await receiver
        assert caught.value is primary
        assert cleanup_failed.is_set()
        snap = instance._failure_evidence.snapshot()
        assert snap['failure']['phase'] == ('receive' if first == 'reader' else 'dispatch')
        assert snap['failure']['causes'][0]['type'] == type(primary).__name__
        assert snap['progress']['consumer']['phase'] == 'callback'
        assert instance._data_queue is None
    finally:
        receiver.cancel()
        await asyncio.gather(receiver, return_exceptions=True)


async def test_reader_processing_failure_is_frozen_before_consumer_failure(parse):
    primary = OSError(32, 'SECRET ping echo')

    class BrokenEcho(QueueSocket):
        async def send(self, _raw):
            raise primary

    async def consume(_tick):
        raise ValueError('SECRET callback')

    ws = BrokenEcho()
    instance = client(ws, consume)
    ws.push(trnm='REAL', data=[0])
    ws.push(trnm='PING')
    with pytest.raises(OSError) as caught:
        await instance._recv_loop(ws)
    assert caught.value is primary
    snap = instance._failure_evidence.snapshot()
    assert snap['failure']['phase'] == 'receive'
    assert snap['failure']['causes'][0] == {'type': 'BrokenPipeError', 'errno': 32}
    assert snap['progress']['reader']['phase'] == 'ping_echo'
    assert snap['progress']['consumer']['phase'] == 'inactive'
    assert snap['queue_depth'] == 1


async def test_rejected_login_captures_before_session_and_transport_cleanup(parse):  # noqa: PLR0915 — one session across rejection and cleanup
    from hoga.live.kiwoom_errors import KiwoomAuthError

    clock = [0.0]
    entered = asyncio.Event()
    at_cleanup = []
    at_close = []
    invalidated = []
    login_errors = []

    class ObservedClose(QueueSocket):
        async def close(self):
            at_close.append(instance._failure_evidence)
            await super().close()

    async def consume(_tick):
        entered.set()
        await asyncio.Event().wait()

    async def account_state(connected, _generation):
        assert not connected
        at_cleanup.append(instance._failure_evidence)
        clock[0] = 9.0

    ws = ObservedClose()
    instance = client(ws, consume, account_events=True, on_account_state=account_state,
                      on_account_row=lambda *_args: asyncio.sleep(0),
                      monotonic_fn=lambda: clock[0], invalidate_fn=lambda: invalidated.append(True))
    login = instance._login

    async def observed_login(socket, token):
        try:
            await login(socket, token)
        except KiwoomAuthError as exc:
            login_errors.append(exc)
            raise

    instance._login = observed_login
    session = asyncio.create_task(instance._session_once())
    try:
        ws.push(trnm='REAL', data=[0])
        await until(entered.is_set)
        ws.push(trnm='REAL', data=[1])
        await until(lambda: instance._data_queue.qsize() == 1)
        clock[0] = 2.0
        ws.push(trnm='LOGIN', return_code=1)
        with pytest.raises(KiwoomAuthError) as caught:
            await session
        assert caught.value is login_errors[0]
        assert (caught.value._kiwoom_phase, caught.value._kiwoom_elapsed_ms) == ('LOGIN', 2000)
        assert invalidated == [True]
        saved = instance._failure_evidence
        assert at_cleanup == at_close == [saved]
        assert saved is not None
        snap = saved.snapshot()
        assert snap['failure']['phase'] == 'LOGIN'
        assert snap['failure']['causes'][0]['type'] == 'KiwoomAuthError'
        assert snap['progress']['consumer']['phase'] == 'callback'
        assert snap['progress']['consumer']['age_ms'] == snap['flow']['inflight_age_ms'] == 2000
        assert snap['flow']['received_frames'] == 2
        assert snap['flow']['completed_frames'] == 0
        assert snap['queue_depth'] == 1
        assert snap['queued_bytes_bound'] > 0
        assert snap['discarded_messages'] == 0
        assert snap['control_attempt']['kind'] == 'LOGIN'
        assert snap['control_attempt']['sender_resumed'] == 2.0
        assert instance._retiring_failure is None
        assert instance._progress.consumer_phase == 'inactive'
        assert ws.closed
        assert not instance._ack_waiters
    finally:
        session.cancel()
        await asyncio.gather(session, return_exceptions=True)


async def test_reconnect_logs_do_not_execute_exception_properties_or_formatting(monkeypatch, caplog):
    touched = []

    class SECRET_ENDPOINT_ERROR(ConnectionError):
        def forbidden(self):
            touched.append(True)
            raise AssertionError('SECRET')
        code = reason = property(forbidden)
        __str__ = __repr__ = forbidden

    primary = SECRET_ENDPOINT_ERROR('SECRET token endpoint account')
    attempts = 0

    async def connect(_url):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            raise primary
        raise asyncio.CancelledError

    instance = client(QueueSocket())
    instance._connect = connect
    monkeypatch.setattr(M, '_BACKOFF_S', (0,))
    with pytest.raises(asyncio.CancelledError):
        await instance.run([])
    assert attempts == 2
    assert touched == []
    assert 'live.kiwoom.reconnect' in caplog.text
    assert '"type":"ConnectionError"' in caplog.text
    assert 'SECRET' not in caplog.text


async def test_quiet_recv_age_is_separate_from_responsive_collector_loop():
    from hoga.live.kiwoom_diagnostics import LoopLagEvidence

    recorder = LoopLagEvidence(interval_s=0)
    probe = asyncio.create_task(recorder.run())
    clock = [1.0]
    ws = QueueSocket()
    instance = client(ws, monotonic_fn=lambda: clock[0])
    receiver = asyncio.create_task(instance._recv_loop(ws))
    configure_failure_context(lambda: {'collector_loop': recorder.snapshot()})
    try:
        ws.push(trnm='PING')
        await until(lambda: ws.sent and recorder.samples)
        clock[0] = 301.0  # Application receive silence, without blocking the collector loop.
        await asyncio.sleep(0)
        evidence = instance._diagnostic_evidence()
        assert evidence['progress']['reader']['phase'] == 'waiting_recv'
        assert evidence['progress']['last_application_recv_age_ms'] == 300000
        assert evidence['runtime']['collector_loop']['state'] == 'active'
        assert evidence['runtime']['collector_loop']['samples']
        assert set(instance.data_queue_snapshot()) == {
            'depth', 'bytes', 'oldest_age_ms', 'overflows', 'discarded_messages', 'wait',
        }
    finally:
        configure_failure_context(None)
        receiver.cancel()
        probe.cancel()
        await asyncio.gather(receiver, probe, return_exceptions=True)


@pytest.mark.parametrize('operation', ['REG', 'VI', 'sector'])
@pytest.mark.parametrize('code', [999, 'SECRET endpoint'])
async def test_registration_rejection_logs_keep_only_numeric_codes(operation, code, monkeypatch, caplog):
    ws = QueueSocket()
    instance = client(ws)

    async def reject(*_args, **_kwargs):
        return {'return_code': code, 'return_msg': 'SECRET payload token'}

    monkeypatch.setattr(instance, '_send_and_wait', reject)
    if operation == 'REG':
        assert not await instance._reg_batch(ws, ['005930'], tr='REG')
    elif operation == 'VI':
        instance._on_vi_row = lambda *_args: None
        await instance._register_vi(ws)
    else:
        instance._on_sector_row = lambda *_args: None
        await instance._register_sectors(ws)
    assert 'reg_rejected' in caplog.text
    assert 'SECRET' not in caplog.text
