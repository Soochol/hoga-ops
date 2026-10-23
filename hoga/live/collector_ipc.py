"""Private local IPC: finite frames, finite outboxes, separate control/data lanes.

Only display delivery may shed frames. Storage runs before/outside this lane;
trade frames are never merged. Epoch/sequence make display gaps observable.
Sockets are inherited via spawn's handle transfer, never publicly bound.
"""
from __future__ import annotations

import asyncio
import json
import socket
import struct
from collections import deque
from collections.abc import Iterator

MAX_FRAME_BYTES = 8 * 1024 * 1024
DISPLAY_MAX_FRAME_BYTES = 256 * 1024
DISPLAY_MAX_MESSAGES = 1024
DISPLAY_MAX_BYTES = 8 * 1024 * 1024
RPC_MAX_PENDING = 32
RPC_TIMEOUT_S = 30.0
STATE_FRESH_S = 10.0
STATE_MAX_PEAK_KEYS = 512


class PeakSnapshotDelta:
    """Cumulative recovery when the bounded state outbox overwrites a frame.

    Sent frames are ordered on one socket. If a previous frame is still queued,
    its replacement must carry a full snapshot, never a delta based on that
    unsent frame. A new epoch always starts with a full snapshot as well.
    """
    def __init__(self) -> None:
        self.previous: dict | None = None
        self.version: int | None = None

    def apply(self, state: dict, *, queued: bool) -> dict:
        peaks = state["peaks"]
        full = self.previous is None or queued or self.version != state["desired_version"]
        changed = peaks if full else {key: value for key, value in peaks.items()
                                     if key not in self.previous or value != self.previous[key]}
        removed = [] if full else list(self.previous.keys() - peaks.keys())
        self.previous = peaks
        self.version = state["desired_version"]
        return {**state, "peaks": changed, "peaks_full": full, "peaks_removed": removed}


def encode(message: dict, *, limit: int = MAX_FRAME_BYTES) -> bytes:
    payload = json.dumps(message, separators=(",", ":"), ensure_ascii=False).encode()
    if len(payload) > limit:
        raise ValueError("collector IPC frame exceeds byte limit")
    return struct.pack("!I", len(payload)) + payload


async def read_frame(reader: asyncio.StreamReader, *, limit: int = MAX_FRAME_BYTES) -> dict:
    size = struct.unpack("!I", await reader.readexactly(4))[0]
    if size > limit:
        raise ValueError("collector IPC peer frame exceeds byte limit")
    value = json.loads(await reader.readexactly(size))
    if not isinstance(value, dict):
        raise ValueError("collector IPC frame must be an object")
    return value


def state_frames(state: dict, *, limit: int = MAX_FRAME_BYTES) -> Iterator[bytes]:
    """Encode one snapshot lazily, splitting only between complete Code/venues.

    The day histories of 512 tracked peak keys can exceed one IPC frame. Keep
    at most one encoded frame at a time; never truncate a key's minute history.
    """
    peaks = state["peaks"]
    if len(peaks) > STATE_MAX_PEAK_KEYS:
        raise ValueError("collector state peak capacity exceeded")
    base = {key: value for key, value in state.items() if key != "peaks"}
    part, entries = 0, []

    def payload(last: bool) -> bytes:
        header = json.dumps({**base, "state_part": part, "state_last": last},
                            separators=(",", ":"), ensure_ascii=False).encode()
        return header[:-1] + b',"peaks":{' + b",".join(entries) + b"}}"

    size = len(payload(False))
    for key, value in peaks.items():
        entry = json.dumps({key: value}, separators=(",", ":"), ensure_ascii=False).encode()[1:-1]
        added = len(entry) + bool(entries)
        if size + added > limit and entries:
            body = payload(False)
            yield struct.pack("!I", len(body)) + body
            part, entries = part + 1, []
            size = len(payload(False))
            added = len(entry)
        if size + added > limit:
            raise ValueError("collector state peak exceeds byte limit")
        entries.append(entry)
        size += added
    body = payload(True)
    if len(body) > limit:
        raise ValueError("collector state metadata exceeds byte limit")
    yield struct.pack("!I", len(body)) + body


async def read_state(reader: asyncio.StreamReader) -> dict:
    """Publish only complete ordered snapshots; partial state is never healthy."""
    state = await read_frame(reader)
    if "state_part" not in state:  # Single-frame peers/tests from before fragmentation.
        return state
    if state.pop("state_part") != 0:
        raise ValueError("collector state missing first part")
    last = state.pop("state_last")
    if len(state["peaks"]) > STATE_MAX_PEAK_KEYS or (not last and not state["peaks"]):
        raise ValueError("collector state peak capacity exceeded")
    part = 0
    while not last:
        fragment = await read_frame(reader)
        part += 1
        if (part >= STATE_MAX_PEAK_KEYS or fragment.get("state_part") != part
                or any(fragment.get(key) != state.get(key) for key in ("epoch", "sequence", "desired_version"))):
            raise ValueError("collector state part mismatch")
        if state["peaks"].keys() & fragment["peaks"].keys():
            raise ValueError("collector state duplicate peak key")
        state["peaks"].update(fragment["peaks"])
        if len(state["peaks"]) > STATE_MAX_PEAK_KEYS:
            raise ValueError("collector state peak capacity exceeded")
        last = fragment["state_last"]
        if not last and not fragment["peaks"]:
            raise ValueError("collector state empty part")
    return state


class LatestStateOutbox:
    """One latest unencoded snapshot, plus the sender's in-flight snapshot.

    Replacements require PeakSnapshotDelta's full recovery. Once sending starts,
    finish every part before taking another snapshot from the slot. Only this
    sender waits for transport capacity, independently of ingestion/storage.
    """
    def __init__(self) -> None:
        self.frames: deque[dict] = deque(maxlen=1)
        self.wake = asyncio.Event()

    def put(self, state: dict) -> None:
        self.frames.append(state)
        self.wake.set()

    async def send(self, writer: asyncio.StreamWriter) -> None:
        while True:
            if not self.frames:
                self.wake.clear()
                await self.wake.wait()
            state = self.frames.popleft()
            for frame in state_frames(state):
                writer.write(frame)
                await writer.drain()


async def open_channel(sock: socket.socket) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    sock.setblocking(False)
    reader, writer = await asyncio.open_connection(sock=sock, limit=MAX_FRAME_BYTES)
    writer.transport.set_write_buffer_limits(high=DISPLAY_MAX_FRAME_BYTES, low=0)
    return reader, writer


class BoundedOutbox:
    def __init__(self, *, max_messages: int = DISPLAY_MAX_MESSAGES, max_bytes: int = DISPLAY_MAX_BYTES):
        self.max_messages, self.max_bytes = max_messages, max_bytes
        self.frames: deque[bytes] = deque()
        self.bytes = 0
        self.dropped = 0
        self.sent = 0
        self.wake = asyncio.Event()

    def put(self, frame: bytes) -> bool:
        if len(frame) > self.max_bytes:
            self.dropped += 1
            return False
        while self.frames and (len(self.frames) >= self.max_messages or self.bytes + len(frame) > self.max_bytes):
            self.bytes -= len(self.frames.popleft())
            self.dropped += 1
        self.frames.append(frame)
        self.bytes += len(frame)
        self.wake.set()
        return True

    async def send(self, writer: asyncio.StreamWriter) -> None:
        while True:
            if not self.frames:
                self.wake.clear()
                await self.wake.wait()
            frame = self.frames.popleft()
            self.bytes -= len(frame)
            writer.write(frame)
            await writer.drain()  # only this display sender waits, never ingest/storage
            self.sent += 1

    def snapshot(self) -> dict:
        return {"messages": len(self.frames), "bytes": self.bytes, "dropped": self.dropped,
                "sent": self.sent, "max_messages": self.max_messages, "max_bytes": self.max_bytes}


class RpcPeer:
    """Bounded duplex RPC. One read loop handles replies while commands await.

    Cancellation removes a waiter; its late reply cannot complete another request.
    One command dispatcher per process avoids concurrent desired-state mutation.
    """
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, epoch: str):
        self.reader, self.writer, self.epoch = reader, writer, epoch
        self.pending: dict[int, asyncio.Future] = {}
        self.sequence = 0
        self.write_lock = asyncio.Lock()
        self.commands: asyncio.Queue[dict] = asyncio.Queue(maxsize=RPC_MAX_PENDING)
        self.closed = asyncio.Event()

    async def write(self, message: dict) -> None:
        frame = encode({**message, "epoch": self.epoch})
        async with self.write_lock:
            self.writer.write(frame)
            await self.writer.drain()

    async def call(self, method: str, args: dict | None = None):
        if self.closed.is_set():
            raise ConnectionError("collector IPC closed")
        if len(self.pending) >= RPC_MAX_PENDING:
            raise ConnectionError("collector IPC request capacity exceeded")
        self.sequence += 1
        request_id = self.sequence
        future = asyncio.get_running_loop().create_future()
        self.pending[request_id] = future
        try:
            async with asyncio.timeout(RPC_TIMEOUT_S):
                await self.write({"id": request_id, "method": method, "args": args or {}})
                return await future
        finally:
            self.pending.pop(request_id, None)

    async def reply(self, command: dict, *, result=None, error: str | None = None):
        await self.write({"reply": command["id"], "result": result, "error": error})

    async def read(self) -> None:
        try:
            while True:
                message = await read_frame(self.reader)
                if message.get("epoch") != self.epoch:
                    raise ValueError("collector IPC epoch mismatch")
                if "reply" in message:
                    future = self.pending.get(message["reply"])
                    if future is not None and not future.done():
                        if message.get("error"):
                            future.set_exception(ConnectionError(message["error"]))
                        else:
                            future.set_result(message.get("result"))
                else:
                    self.commands.put_nowait(message)
        finally:
            self.closed.set()
            for future in self.pending.values():
                if not future.done():
                    future.set_exception(ConnectionError("collector IPC disconnected"))
