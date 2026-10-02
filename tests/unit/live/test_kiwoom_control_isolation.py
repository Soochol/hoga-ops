"""Control reception must progress while the ordered data consumer is blocked."""
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
    configure_failure_context(lambda: {'commit': 'abc123', 'live_started_at_ms': 123,
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
        assert '"commit":"abc123"' in caplog.text
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
