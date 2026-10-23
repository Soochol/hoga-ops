"""Single-key day histories, atomic publication and real IPC backpressure."""
from __future__ import annotations

import asyncio
import json
import socket
from types import SimpleNamespace

import pytest

from hoga.live import collector_ipc as ipc
from hoga.live.ask_peak_state import Peak
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_transfer import TRANSFER_FRAME_BYTES, tree_frames, write_frames
from hoga.live.collector_worker import CollectorWorker
from tests.unit.live.test_collector_state_frames import Writer, snapshot, until
from tests.unit.live.test_peak_shadow import STAMP, book, stream


async def large_owner(root, points=90_000):
    owner = stream(root)
    await owner.on_tick(book(stamp=STAMP))
    for state in (owner._ask_peak_state("005930", "KRX"), owner._bid_peak_state("005930", "KRX")):
        # Legal uncapped native history; distinct real Peak objects, not repeated
        # references. Subsequent callbacks exercise the actual native mutation.
        state.all_record = [Peak(100, 1_000_000 + i, STAMP + i) for i in range(points)]
    await owner.on_tick(book(2_000_000, stamp=STAMP + points + 1))
    return owner


def values(owner):
    return {"005930:KRX": {"ask": owner.ask_peak_snapshot("005930", "KRX"),
                           "bid": owner.bid_peak_snapshot("005930", "KRX")}}


async def test_single_large_native_key_worker_state_and_seed_rpc_both_roundtrip(tmp_path, monkeypatch):
    owner = await large_owner(tmp_path / "native")
    worker = CollectorWorker(tmp_path, "test", SimpleNamespace(), manager_factory=lambda **kwargs: SimpleNamespace())
    worker.manager.capture_streams = lambda: [owner]
    monkeypatch.setattr("hoga.live.collector_worker.today", lambda: "20261023")
    key = ("005930", "KRX", "20261023")
    worker.state_sequence = 1
    worker.peak_keys = {key}
    worker.peak_owners[key] = lambda: owner
    state = snapshot(1, worker.peaks())
    with pytest.raises(ValueError, match="byte limit"):
        ipc.encode(state)
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    reader = asyncio.StreamReader()
    writer = Writer(reader)
    task = asyncio.create_task(session._states(reader, "test"))
    try:
        await write_frames(writer, ipc.state_frames(state))
        await until(lambda: session._state_sequence == 1)
        assert session._peaks == state["peaks"]
        assert max(writer.sizes) <= TRANSFER_FRAME_BYTES
        assert sum(writer.sizes) > ipc.MAX_FRAME_BYTES
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
    # The same actual worker command used by ensure_today_peaks_seeded must
    # succeed, rather than merely fixing the periodic state path.
    left, right = socket.socketpair()
    parent, child = await ipc.open_channel(left), await ipc.open_channel(right)
    session.peer = ipc.RpcPeer(*parent, "test")
    worker.peer = ipc.RpcPeer(*child, "test")
    monkeypatch.setattr(session, "fresh", lambda: True)
    tasks = [asyncio.create_task(session.peer.read()), asyncio.create_task(worker.peer.read()),
             asyncio.create_task(worker.commands())]
    try:
        session._peaks = {"other:KRX": {"ask": None, "bid": None}}
        await session.ensure_today_peaks_seeded(*key)
        assert session._peaks == {"other:KRX": {"ask": None, "bid": None}, **state["peaks"]}
        assert not worker.peer.closed.is_set()
        assert all(not task.done() for task in tasks)
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for _, channel in (parent, child):
            channel.close()
            await channel.wait_closed()


@pytest.mark.parametrize("fault", ["missing", "duplicate", "offset", "length", "epoch", "sequence",
                                   "version", "early_last", "duplicate_path"])
async def test_malformed_new_parts_never_publish_a_prefix(tmp_path, fault):
    state = snapshot(1, {"005930:KRX": {"ask": {"all_record_peaks": list(range(1000))}}})
    frames = [json.loads(frame[4:]) for frame in ipc.state_frames(state, limit=700)]
    middle = next(i for i, frame in enumerate(frames) if i > 0
                  and any(op[0] == "append" for op in frame["ops"]))
    if fault == "missing":
        frames.pop(middle)
    elif fault == "duplicate":
        frames.insert(middle, frames[middle])
    elif fault in {"epoch", "sequence", "version"}:
        name = "desired_version" if fault == "version" else fault
        frames[middle]["_transfer"][name] = "wrong"
    elif fault == "early_last":
        frames[middle]["last"] = True
    elif fault == "duplicate_path":
        frames[-1]["ops"].append(["put", ["peaks"], {}])
    else:
        op = next(op for op in frames[0]["ops"] if op[0] == "list") if fault == "length" else next(
            op for op in frames[middle]["ops"] if op[0] == "append")
        op[2 if fault == "length" else 1] += 1
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    session._peaks = {"old:KRX": 1}
    reader = asyncio.StreamReader()
    for frame in frames:
        reader.feed_data(ipc.encode(frame))
    reader.feed_eof()
    with pytest.raises(ValueError, match="transfer"):
        await session._states(reader, "test")
    assert session._peaks == {"old:KRX": 1} and session._received_at == 0


async def test_new_transfer_eof_preserves_previous_state(tmp_path):
    frames = ipc.state_frames(snapshot(2, {"a": {"history": list(range(1000))}}), limit=700)
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    session._peaks, session._received_at, session._state_sequence = {"a": "old"}, 123, 1
    reader = asyncio.StreamReader()
    reader.feed_data(next(frames))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await session._states(reader, "test")
    assert session._peaks == {"a": "old"} and session._received_at == 123


async def test_sender_and_buffered_receiver_yield_even_when_drain_never_suspends():
    reader = asyncio.StreamReader()
    counts, scheduling = [], []

    class ImmediateWriter:
        def write(self, frame):
            counts.append(len(frame))
            reader.feed_data(frame)

        async def drain(self):
            return

    async def observer():
        while True:
            scheduling.append(len(counts))
            await asyncio.sleep(0)

    message = snapshot(1, {"a": {"history": list(range(2000))}})
    task = asyncio.create_task(observer())
    try:
        await write_frames(ImmediateWriter(), ipc.state_frames(message, limit=700))
        assert any(0 < count < len(counts) for count in scheduling)
        scheduling.clear()
        assert await ipc.read_state(reader) == message
        assert len(scheduling) > 1
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)


async def test_canceled_chunked_rpc_drains_then_accepts_next_reply_without_building_tree(monkeypatch):
    from hoga.live import collector_transfer as transfer

    reader = asyncio.StreamReader()
    peer = ipc.RpcPeer(reader, None, "test")
    future = asyncio.get_running_loop().create_future()
    peer.pending[1] = future
    applied = []
    original = transfer._Tree.apply

    def record(tree, operation):
        applied.append(operation[0])
        return original(tree, operation)

    monkeypatch.setattr(transfer._Tree, "apply", record)
    frames = iter(tree_frames({"epoch": "test", "reply": 1, "result": {"rows": list(range(1000))}},
                             {"kind": "peak_reply", "epoch": "test", "reply": 1}, limit=700))
    task = asyncio.create_task(peer.read())
    try:
        reader.feed_data(next(frames))
        await until(lambda: applied)
        peer.pending.pop(1)
        future.cancel()
        count = len(applied)
        for frame in frames:
            reader.feed_data(frame)
        next_future = asyncio.get_running_loop().create_future()
        peer.pending[2] = next_future
        reader.feed_data(ipc.encode({"epoch": "test", "reply": 2, "result": "next"}))
        assert await next_future == "next"
        assert len(applied) == count
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        peer.pending.clear()


async def test_other_rpc_writes_cannot_interleave_a_chunked_reply():
    reader = asyncio.StreamReader()
    writer = Writer(reader)
    outgoing, incoming = ipc.RpcPeer(None, writer, "test"), ipc.RpcPeer(reader, None, "test")
    expected = {"rows": list(range(100_000))}
    futures = [asyncio.get_running_loop().create_future() for _ in range(2)]
    incoming.pending = dict(enumerate(futures, 1))
    read = asyncio.create_task(incoming.read())
    first = asyncio.create_task(outgoing.reply({"id": 1, "method": "peaks"}, result=expected))
    try:
        await until(lambda: writer.sizes)
        # Contends for the same write lock after the first chunk is visible.
        second = asyncio.create_task(outgoing.reply({"id": 2, "method": "token"}, result="token"))
        assert await futures[0] == expected
        assert await futures[1] == "token"
        await asyncio.gather(first, second)
    finally:
        first.cancel()
        read.cancel()
        await asyncio.gather(first, read, return_exceptions=True)
        incoming.pending.clear()


async def test_early_last_at_completed_array_boundary_still_requires_end_marker():
    message = snapshot(1, {"a": {"first": list(range(1000)), "second": list(range(1000))}})
    frames = [json.loads(frame[4:]) for frame in ipc.state_frames(message, limit=700)]
    # Drop the tail at an otherwise valid boundary; root identity and every
    # remaining array length alone would not catch the absent second field.
    frame = frames[-1]
    frame["ops"] = [op for op in frame["ops"] if op[0] != "end"]
    reader = asyncio.StreamReader()
    for value in frames:
        reader.feed_data(ipc.encode(value))
    with pytest.raises(ValueError, match="end marker"):
        await ipc.read_state(reader)


async def test_real_blocked_socket_does_not_stop_native_ingest_and_durable_flush(tmp_path):
    owner, reference = stream(tmp_path / "new"), stream(tmp_path / "old")
    state = snapshot(1, {"a": {"history": [{"qty": 1}] * 100_000}})
    left, right = socket.socketpair()
    sender, receiver = await ipc.open_channel(left), await ipc.open_channel(right)
    receiver[1].transport.pause_reading()
    send = asyncio.create_task(write_frames(sender[1], ipc.state_frames(state)))
    try:
        await until(lambda: sender[1].transport.get_write_buffer_size() > TRANSFER_FRAME_BYTES)
        assert not send.done()  # Real transport pressure, not a mocked sleep.
        for index in range(100):
            tick = book(index, stamp=STAMP + index * 1000)
            await owner.on_tick(tick)
            await reference.on_tick(tick)
        for native in (owner, reference):
            await native.flush_once(now_ms=STAMP + 120_000)
            await native._writer.fsync_all()
        assert values(owner) == values(reference)
        assert not send.done()
        paths = list((tmp_path / "old").rglob("*.jsonl"))
        assert paths
        for path in paths:
            assert path.read_bytes() == (tmp_path / "new" / path.relative_to(tmp_path / "old")).read_bytes()
        receiver[1].transport.resume_reading()
        assert await ipc.read_state(receiver[0]) == state
        await send
    finally:
        send.cancel()
        await asyncio.gather(send, return_exceptions=True)
        for _, writer in (sender, receiver):
            writer.close()
            await writer.wait_closed()
