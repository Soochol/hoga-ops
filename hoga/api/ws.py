"""Single WebSocket transport for live push (ADR-0053).

Multiplexes global app events (EventBus) and per-code live snapshots (LiveBuffer)
into {ch, data} frames over one connection per tab, replacing the two SSE
endpoints. live frames are code-tagged so one socket can carry 0..N codes.
Data sources are unchanged — this is a wire-transport layer only.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Callable

logger = logging.getLogger(__name__)

from fastapi import APIRouter, WebSocket

from hoga.api.events import EventBus
from hoga.live.buffer import LiveBuffer

_PING_TIMEOUT_S = 30.0


def build_ws_router(
    bus: EventBus,
    get_buffer: Callable[[], LiveBuffer | None],
    *,
    ping_timeout_s: float = _PING_TIMEOUT_S,
) -> APIRouter:
    router = APIRouter()

    @router.websocket("/api/ws")
    async def _ws(websocket: WebSocket) -> None:
        await websocket.accept()
        out: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        bus_q = bus.subscribe()
        code_subs: dict[str, tuple[asyncio.Queue[dict], asyncio.Task[None]]] = {}

        def emit(frame: dict) -> None:
            try:
                out.put_nowait(frame)
            except asyncio.QueueFull:
                # Slow client: log so the consistency gap is visible (mirrors EventBus.publish).
                logger.warning("WS send queue full, dropped frame: %s", frame.get("ch"))

        async def pump_event() -> None:
            while True:
                emit({"ch": "event", "data": await bus_q.get()})

        async def pump_live(code: str, q: asyncio.Queue[dict]) -> None:
            while True:
                emit({"ch": "live", "code": code, "data": await q.get()})

        bus_task = asyncio.create_task(pump_event())

        async def sender() -> None:
            while True:
                try:
                    frame = await asyncio.wait_for(out.get(), timeout=ping_timeout_s)
                except asyncio.TimeoutError:
                    frame = {"ch": "heartbeat"}
                await websocket.send_json(frame)

        async def receiver() -> None:
            while True:
                msg = await websocket.receive_json()
                action = msg.get("action")
                code = msg.get("code")
                if action == "subscribe" and isinstance(code, str):
                    if code not in code_subs:
                        buf = get_buffer()
                        if buf is None:
                            continue
                        q = buf.subscribe(code)
                        code_subs[code] = (q, asyncio.create_task(pump_live(code, q)))
                    emit({"ch": "subscribed", "code": code})
                elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
                    q, task = code_subs.pop(code)
                    task.cancel()
                    buf = get_buffer()
                    if buf is not None:
                        buf.unsubscribe(code, q)

        send_task = asyncio.create_task(sender())
        recv_task = asyncio.create_task(receiver())
        try:
            await asyncio.wait({send_task, recv_task}, return_when=asyncio.FIRST_COMPLETED)
        except asyncio.CancelledError:
            # The endpoint task itself was cancelled (e.g. ASGI server / test-client
            # teardown tearing the connection down out from under us, rather than a
            # clean client disconnect). Swallow after the finally cleanup so the
            # cancellation doesn't propagate to the caller as an error — teardown is
            # not a failure. (Fixes a CancelledError leaking out of Starlette's
            # TestClient portal under load.)
            pass
        finally:
            for t in (send_task, recv_task, bus_task):
                t.cancel()
            subs = list(code_subs.items())
            for _code, (_q, task) in subs:
                task.cancel()
            await asyncio.gather(
                send_task, recv_task, bus_task,
                *(task for _code, (_q, task) in subs),
                return_exceptions=True,
            )
            buf = get_buffer()
            if buf is not None:
                for code, (q, _task) in subs:
                    buf.unsubscribe(code, q)
            bus.unsubscribe(bus_q)

    return router
