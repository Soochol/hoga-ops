"""Drive the repository WS router over real, isolated Uvicorn TCP transport."""
import argparse
import asyncio
import json
import socket
import time
from dataclasses import asdict, dataclass
from http import HTTPStatus

import httpx
import uvicorn
from fastapi import FastAPI
from uvicorn.protocols.websockets.websockets_impl import WebSocketProtocol
from websockets.exceptions import ConnectionClosed
from websockets.frames import CloseCode
from websockets.legacy.client import WebSocketClientProtocol, connect

from hoga.api.events import EventBus
from hoga.api.ws import build_ws_router
from hoga.live import lifecycle
from hoga.live.buffer import LiveBuffer


@dataclass
class Observation:
    case: str
    compression: bool
    count: int
    delay: float
    keepalive: float
    subscribed: int = 0
    work_started: int = 0
    work_completed: int = 0
    client_pongs: int = 0
    queue_max: int = 0
    put_waiter_seen: bool = False
    pings_pending_max: int = 0
    loop_lag_max: float = 0
    close_code: int | None = None
    close_reason: str = ""
    health_status: int = 0
    transport_error: str = ""


async def receive_frames(client, row, completed, duration):
    deadline = time.monotonic() + duration
    try:
        while time.monotonic() < deadline:
            frame = json.loads(await asyncio.wait_for(client.recv(), timeout=duration))
            if frame.get("ch") == "subscribed":
                code = frame["code"]
                assert code in completed, ("ACK before effect", code)
                assert code == f"{row.subscribed:06d}", ("ACK out of order", code)
                row.subscribed += 1
    except ConnectionClosed as error:
        row.close_code = error.rcvd.code if error.rcvd else error.code
        row.close_reason = error.rcvd.reason if error.rcvd else error.reason


async def observe_transport(row, transports, stopping):
    previous = time.monotonic()
    while not stopping.is_set():
        await asyncio.sleep(0.005)
        now = time.monotonic()
        row.loop_lag_max = max(row.loop_lag_max, now - previous - 0.005)
        previous = now
        for protocol in transports:
            row.queue_max = max(row.queue_max, len(protocol.messages))
            row.put_waiter_seen |= protocol._put_message_waiter is not None
            row.pings_pending_max = max(row.pings_pending_max, len(protocol.pings))


async def run(case, *, compression, count, delay, keepalive, duration):
    row = Observation(case, compression, count, delay, keepalive)
    transports = []
    completed = set()
    stopping = asyncio.Event()

    class Protocol(WebSocketProtocol):
        def connection_made(self, transport):
            transports.append(self)
            super().connection_made(transport)

        def fail_connection(self, code=1006, reason=""):
            row.transport_error = reason
            super().fail_connection(code, reason)

    class Client(WebSocketClientProtocol):
        async def pong(self, data=b""):
            row.client_pongs += 1
            await super().pong(data)

    async def do_work(code):
        row.work_started += 1
        await asyncio.sleep(delay)
        row.work_completed += 1
        completed.add(code)
        return True

    async def subscribe(code, venues=None, *, ref=None):
        return await do_work(code)

    async def unsubscribe(*args, **kwargs):
        return None

    old_subscribe = lifecycle.on_view_subscribe
    old_unsubscribe = lifecycle.on_view_unsubscribe
    lifecycle.on_view_subscribe = subscribe
    lifecycle.on_view_unsubscribe = unsubscribe
    app = FastAPI()
    buffer = LiveBuffer()
    app.include_router(build_ws_router(EventBus(), lambda: buffer, ping_timeout_s=0.05))

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    config = uvicorn.Config(app, host="127.0.0.1", port=port, ws=Protocol,
                            ws_ping_interval=keepalive, ws_ping_timeout=keepalive,
                            ws_per_message_deflate=compression, log_level="critical",
                            lifespan="off", timeout_graceful_shutdown=1)
    server = uvicorn.Server(config)
    server_task = asyncio.create_task(server.serve(sockets=[sock]))

    sample_task = asyncio.create_task(observe_transport(row, transports, stopping))
    try:
        while not server.started:
            await asyncio.sleep(0.005)
        async with connect(f"ws://127.0.0.1:{port}/api/ws", create_protocol=Client,
                           ping_interval=None, close_timeout=0.1) as client:
            for index in range(count):
                await client.send(json.dumps({"action": "subscribe", "code": f"{index:06d}", "protocol": 2}))
            await receive_frames(client, row, completed, duration)
        async with httpx.AsyncClient() as http:
            response = await http.get(f"http://127.0.0.1:{port}/health")
            row.health_status = response.status_code
    finally:
        stopping.set()
        sample_task.cancel()
        await asyncio.gather(sample_task, return_exceptions=True)
        server.should_exit = True
        await server_task
        lifecycle.on_view_subscribe = old_subscribe
        lifecycle.on_view_unsubscribe = old_unsubscribe
    print(json.dumps(asdict(row)), flush=True)
    return row


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect-disconnected", action="store_true")
    parser.add_argument("--full-scale", action="store_true")
    parser.add_argument("--repeats", type=int, default=5)
    args = parser.parse_args()
    for _ in range(args.repeats):
        row = await run("router", compression=True,
                        count=214 if args.full_scale else 96,
                        delay=0.5 if args.full_scale else 0.015,
                        keepalive=20 if args.full_scale else 0.2,
                        duration=110 if args.full_scale else 2.0)
        assert row.health_status == HTTPStatus.OK, asdict(row)
        if args.expect_disconnected:
            assert row.close_code == CloseCode.INTERNAL_ERROR, asdict(row)
            assert row.put_waiter_seen and row.client_pongs, asdict(row)
            assert row.transport_error == "keepalive ping timeout", asdict(row)
        else:
            assert row.close_code is None and not row.transport_error, asdict(row)
            assert row.subscribed == row.work_completed == row.count, asdict(row)
            assert row.client_pongs, asdict(row)
    print(json.dumps({"cases": args.repeats, "passed_assertions": True}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
