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

MAX_FRAME_BYTES = 8 * 1024 * 1024
DISPLAY_MAX_FRAME_BYTES = 256 * 1024
DISPLAY_MAX_MESSAGES = 1024
DISPLAY_MAX_BYTES = 8 * 1024 * 1024
RPC_MAX_PENDING = 32
RPC_TIMEOUT_S = 30.0
STATE_FRESH_S = 10.0


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
