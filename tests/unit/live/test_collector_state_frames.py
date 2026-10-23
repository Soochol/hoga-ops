"""Large day-peak histories must not kill the capture owner or lose minutes."""
from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live import collector_ipc as ipc
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_worker import CollectorWorker


def snapshot(sequence, peaks):
    return {"epoch": "test", "sequence": sequence, "desired_version": 1, "peaks": peaks,
            "ready": True, "observed_at_ms": int(time.time() * 1000)}


def large_peaks():
    # Real minute-history fields, 390 minutes on both sides for 100 queried keys.
    bars = [{"price": 100_000, "qty": 1_000_000, "t_ms": 1_790_000_000_000 + i * 60_000}
            for i in range(390)]
    side = {"date": "20261023", "coverage": "full", "traded_bar_peaks": bars,
            "all_bar_peaks": bars, "unreached_bar_peaks": bars}
    return {f"{i:06}:KRX": {"ask": side, "bid": side} for i in range(100)}


async def until(predicate):
    async with asyncio.timeout(15):
        while not predicate():
            await asyncio.sleep(0)


class Writer:
    def __init__(self, reader):
        self.reader = reader
        self.sizes = []
        self.release = asyncio.Event()
        self.release.set()

    def write(self, frame):
        self.sizes.append(len(frame) - 4)
        self.reader.feed_data(frame)

    async def drain(self):
        await self.release.wait()
        await asyncio.sleep(0)


async def test_actual_worker_and_parent_transfer_more_than_8mib_without_losing_history(tmp_path):
    peaks = large_peaks()
    state = snapshot(1, peaks)
    with pytest.raises(ValueError, match="byte limit"):
        ipc.encode(state)  # Reproduces the production exception before the fix.
    worker = object.__new__(CollectorWorker)
    worker.state = lambda: state
    worker.peak_delta = ipc.PeakSnapshotDelta()
    worker.state_outbox = ipc.LatestStateOutbox()
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version, session.ack_version = "test", 1, 1
    session.alive = lambda: True
    session.peer = SimpleNamespace(closed=asyncio.Event())
    reader = asyncio.StreamReader()
    writer = Writer(reader)
    producer = asyncio.create_task(worker.states())
    tasks = [producer]
    try:
        await until(lambda: bool(worker.state_outbox.frames))
        tasks += [asyncio.create_task(worker.state_outbox.send(writer)),
                  asyncio.create_task(session._states(reader, "test"))]
        await until(session.fresh)
        assert not producer.done()
        assert session._peaks == peaks
        assert len(writer.sizes) > 1
        assert max(writer.sizes) <= ipc.MAX_FRAME_BYTES
        assert sum(writer.sizes) > ipc.MAX_FRAME_BYTES
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def test_slow_sender_finishes_inflight_snapshot_and_recovers_replaced_delta(tmp_path, monkeypatch):
    original = ipc.state_frames
    monkeypatch.setattr(ipc, "state_frames", lambda state: original(state, limit=700))
    delta, outbox = ipc.PeakSnapshotDelta(), ipc.LatestStateOutbox()
    first = {key: {"history": "x" * 300} for key in ("a", "b", "c")}
    outbox.put(delta.apply(snapshot(1, first), queued=False))
    reader = asyncio.StreamReader()
    writer = Writer(reader)
    writer.release.clear()
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    tasks = [asyncio.create_task(outbox.send(writer)), asyncio.create_task(session._states(reader, "test"))]
    try:
        await until(lambda: writer.sizes)
        # One partial frame is visible, but no state/freshness has been published.
        assert session._state_sequence == 0 and session._received_at == 0
        outbox.put(delta.apply(snapshot(2, {**first, "b": 2}), queued=bool(outbox.frames)))
        final = {"a": first["a"], "b": 2, "d": {"history": "y" * 300}}
        outbox.put(delta.apply(snapshot(3, final), queued=bool(outbox.frames)))
        assert len(outbox.frames) == 1 and outbox.frames[0]["peaks_full"]
        writer.release.set()
        await until(lambda: session._state_sequence == 3)
        assert session._peaks == final
        outbox.put(delta.apply(snapshot(4, {**final, "b": 4}), queued=False))
        await until(lambda: session._state_sequence == 4)
        assert session._peaks == {**final, "b": 4}
        assert max(writer.sizes) <= 700
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


@pytest.mark.parametrize("peaks", [{}, {"삼성:KRX": {"text": '한글"\\' * 20}, "다음:KRX": [1] * 40}])
async def test_frame_size_counts_utf8_and_json_escaping(peaks):
    state = snapshot(1, peaks)
    frames = list(ipc.state_frames(state, limit=500))
    assert all(len(frame) - 4 <= 500 for frame in frames)
    reader = asyncio.StreamReader()
    for frame in frames:
        reader.feed_data(frame)
    assert await ipc.read_state(reader) == state


@pytest.mark.parametrize("change", [{"state_part": 2}, {"epoch": "old"}, {"sequence": 2},
                                   {"desired_version": 2}, {"peaks": {"a": 2}}])
async def test_incomplete_or_mixed_state_is_rejected(change):
    reader = asyncio.StreamReader()
    reader.feed_data(ipc.encode({**snapshot(1, {"a": 1}), "state_part": 0, "state_last": False}))
    reader.feed_data(ipc.encode({**snapshot(1, {"b": 1}), "state_part": 1, "state_last": True, **change}))
    with pytest.raises(ValueError, match="part mismatch|duplicate peak"):
        await ipc.read_state(reader)


async def test_disconnect_mid_snapshot_cannot_publish_partial_state(tmp_path):
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    reader = asyncio.StreamReader()
    reader.feed_data(ipc.encode({**snapshot(1, {"a": 1}), "state_part": 0, "state_last": False}))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await session._states(reader, "test")
    assert session._state == {} and session._peaks == {} and session._received_at == 0


def test_single_oversized_key_and_too_many_keys_still_fail_explicitly():
    with pytest.raises(ValueError, match="peak exceeds byte limit"):
        list(ipc.state_frames(snapshot(1, {"a": "x" * 1000}), limit=500))
    with pytest.raises(ValueError, match="capacity"):
        list(ipc.state_frames(snapshot(1, dict.fromkeys(map(str, range(ipc.STATE_MAX_PEAK_KEYS + 1)), 1))))


@pytest.mark.parametrize("values", [{"a:KRX": {"ask": 2}}, {}])
async def test_scoped_seed_reply_preserves_other_keys_and_survives_older_full_state(tmp_path, monkeypatch, values):
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    monkeypatch.setattr(session, "fresh", lambda: True)
    session._peaks = {"a:KRX": {"ask": 1}, "b:KRX": {"ask": 1}}
    session.peer = SimpleNamespace(call=AsyncMock(return_value={"values": values, "state_sequence": 2}))
    await session.ensure_today_peaks_seeded("a", "KRX", "20261023")
    expected = {**values, "b:KRX": {"ask": 1}}
    assert session._peaks == expected
    reader = asyncio.StreamReader()
    reader.feed_data(ipc.encode({**snapshot(2, {"a:KRX": {"ask": 0}, "b:KRX": {"ask": 3}}), "peaks_full": True}))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await session._states(reader, "test")
    assert session._peaks == {**values, "b:KRX": {"ask": 3}}
    reader = asyncio.StreamReader()
    current = {"a:KRX": {"ask": 4}, "b:KRX": {"ask": 4}}
    reader.feed_data(ipc.encode({**snapshot(3, current), "peaks_full": True}))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await session._states(reader, "test")
    assert session._peaks == current and session._peak_sequence_floors == {}


async def test_worker_seed_rpc_returns_only_requested_key(tmp_path, monkeypatch):
    from hoga.live import collector_worker as module

    monkeypatch.setattr(module, "today", lambda: "20261023")
    worker = CollectorWorker(tmp_path, "test", SimpleNamespace(), manager_factory=lambda **kwargs: SimpleNamespace())
    stream = SimpleNamespace(owns_code=lambda code: True,
                             ask_peak_snapshot=lambda *args: {"ask": 1},
                             bid_peak_snapshot=lambda *args: {"bid": 1})
    worker.manager.capture_streams = lambda: [stream]
    key = ("005930", "KRX", "20261023")
    worker.peak_keys = {key, ("000660", "KRX", "20261023")}
    worker.peak_owners[key] = lambda: stream
    result = await worker.command("peaks", {"code": "005930", "venue": "KRX", "date": "20261023"})
    assert result["values"] == {"005930:KRX": {"ask": {"ask": 1}, "bid": {"bid": 1}}}
    # There is no aggregate copy of other queried day histories in the reply.
    assert len(ipc.encode(result)) < 500
