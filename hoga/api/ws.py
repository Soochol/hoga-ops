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
_VALID_VENUES = ("KRX", "NXT")


def _parse_venues(raw: object) -> set[str] | None:
    """구독 메시지의 venues 옵션 → {KRX,NXT} 부분집합. 미지정/불량이면 None
    (lifecycle이 현재 창 venue 1개로 기본 — 구 프론트 하위호환). KRX=KRX옵션,
    NXT=NXT옵션, {KRX,NXT}=UN옵션(ADR-0118 §4 3옵션 직결)."""
    if not isinstance(raw, list):
        return None
    venues = {v for v in raw if v in _VALID_VENUES}
    return venues or None


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
        # ADR-0067: local import to avoid circular imports at module level.
        # Placed here so both receiver() closure and finally block can access it.
        from hoga.live import lifecycle  # noqa: PLC0415
        out: asyncio.Queue[dict] = asyncio.Queue(maxsize=2048)
        bus_q = bus.subscribe()
        # code → (버퍼 큐, pump 태스크, 구독 venues). venues는 해제 시 동일 키 제거용.
        code_subs: dict[
            str, tuple[asyncio.Queue[dict], asyncio.Task[None], set[str] | None]
        ] = {}
        # 이 연결(탭) 식별 토큰 — 참조 카운트 장부의 ref. 두 탭이 같은 종목을 봐도
        # 각자 ref라 refcount가 정확(한 탭 닫아도 다른 탭 유지, ADR-0118 PR-C).
        view_ref = f"ws-{id(out)}"

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
                        venues = _parse_venues(msg.get("venues"))
                        code_subs[code] = (q, asyncio.create_task(pump_live(code, q)), venues)
                        # ADR-0067/PR-C: forward to REST poller + 키움 표시셋 lifecycle.
                        # 만석(전 연결 슬롯 소진)이면 이 탭에 만석 이벤트(토스트).
                        accepted = await lifecycle.on_view_subscribe(code, venues, ref=view_ref)
                        if not accepted:
                            emit({"ch": "event",
                                  "data": {"type": "kiwoom_full_house", "code": code}})
                    emit({"ch": "subscribed", "code": code})
                elif action == "unsubscribe" and isinstance(code, str) and code in code_subs:
                    q, task, venues = code_subs.pop(code)
                    task.cancel()
                    buf = get_buffer()
                    if buf is not None:
                        buf.unsubscribe(code, q)
                    # ADR-0067/PR-C: forward to REST poller + 키움 표시셋 lifecycle.
                    await lifecycle.on_view_unsubscribe(code, venues, ref=view_ref)

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
            for _code, (_q, task, _v) in subs:
                task.cancel()
            await asyncio.gather(
                send_task, recv_task, bus_task,
                *(task for _code, (_q, task, _v) in subs),
                return_exceptions=True,
            )
            buf = get_buffer()
            if buf is not None:
                for code, (q, _task, _v) in subs:
                    buf.unsubscribe(code, q)
            # ADR-0067/PR-C: ghost-polling prevention — unsubscribe all subscribed
            # codes from the REST poller + 키움 표시셋 lifecycle on disconnect.
            for code, (_q, _task, venues) in subs:
                await lifecycle.on_view_unsubscribe(code, venues, ref=view_ref)
            bus.unsubscribe(bus_q)

    return router
