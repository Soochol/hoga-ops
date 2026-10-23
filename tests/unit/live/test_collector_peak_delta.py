from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hoga.live.collector_ipc import BoundedOutbox, PeakSnapshotDelta, encode
from hoga.live.collector_process import CaptureProcessSession


def state(sequence, peaks, version=1):
    return {"sequence": sequence, "desired_version": version, "peaks": peaks}


def consume(current, frame):
    if frame["peaks_full"]:
        return dict(frame["peaks"])
    current.update(frame["peaks"])
    for key in frame["peaks_removed"]:
        current.pop(key, None)
    return current


def test_delta_preserves_unchanged_references_and_removes_expired_keys():
    delta = PeakSnapshotDelta()
    a, b = {"ask": [1]}, {"bid": [2]}
    current = consume({}, delta.apply(state(1, {"a": a, "b": b}), queued=False))
    frame = delta.apply(state(2, {"a": {"ask": [1]}, "b": {"bid": [3]}}), queued=False)
    assert frame["peaks"] == {"b": {"bid": [3]}}
    current = consume(current, frame)
    assert current["a"] is a
    current = consume(current, delta.apply(state(3, {"b": {"bid": [3]}}), queued=False))
    assert current == {"b": {"bid": [3]}}


def test_overwritten_state_recovers_every_unsent_change():
    delta, outbox = PeakSnapshotDelta(), BoundedOutbox(max_messages=1)
    current = consume({}, delta.apply(state(1, {"a": 1, "b": 1}), queued=False))
    for sequence, peaks in [(2, {"a": 2, "b": 1}), (3, {"a": 2, "b": 3})]:
        outbox.put(encode(delta.apply(state(sequence, peaks), queued=bool(outbox.frames))))
    assert outbox.dropped == 1
    delivered = json.loads(outbox.frames[0][4:])
    assert delivered["peaks_full"]
    assert consume(current, delivered) == {"a": 2, "b": 3}


def test_new_desired_version_forces_full_recovery():
    delta = PeakSnapshotDelta()
    delta.apply(state(1, {"a": 1}), queued=False)
    frame = delta.apply(state(2, {"a": 1}, version=2), queued=False)
    assert frame["peaks_full"]
    assert frame["peaks"] == {"a": 1}


async def test_actual_parent_applies_delta_and_recovers_a_dropped_frame(tmp_path):
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    delta = PeakSnapshotDelta()
    reader = asyncio.StreamReader()
    for sequence, peaks, queued in [(1, {"a": 1, "b": 1}, False), (2, {"a": 2, "b": 1}, False),
                                    (4, {"b": 4}, True)]:
        reader.feed_data(encode({"epoch": "test", **delta.apply(state(sequence, peaks), queued=queued)}))
    reader.feed_eof()
    with pytest.raises(asyncio.IncompleteReadError):
        await session._states(reader, "test")
    assert session._peaks == {"b": 4}


async def test_actual_parent_rejects_delta_gap(tmp_path):
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    session.epoch, session.version = "test", 1
    reader = asyncio.StreamReader()
    reader.feed_data(encode({"epoch": "test", **state(3, {"a": 3}), "peaks_full": False}))
    with pytest.raises(ValueError, match="without recovery"):
        await session._states(reader, "test")


@pytest.mark.parametrize(("sequence", "floor", "reply"), [(3, 0, 2), (3, 5, 4)])
async def test_late_seed_rpc_does_not_rewind_a_newer_state_delta(tmp_path, monkeypatch, sequence, floor, reply):
    session = CaptureProcessSession(buffer=None, data_dir=tmp_path)
    monkeypatch.setattr(session, "fresh", lambda: True)
    session._state_sequence = sequence
    session._peak_sequence_floors = {"005930:KRX": floor}
    session._peaks = {"005930:KRX": {"ask": 3}}
    session.peer = SimpleNamespace(call=AsyncMock(return_value={
        "values": {"005930:KRX": {"ask": 2}}, "state_sequence": reply,
    }))
    await session.ensure_today_peaks_seeded("005930", "KRX", "20261019")
    assert session._peaks == {"005930:KRX": {"ask": 3}}
