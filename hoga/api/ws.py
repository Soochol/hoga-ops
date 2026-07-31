"""Single WebSocket transport for live push (ADR-0053).

Multiplexes global app events (EventBus) and per-code live snapshots (LiveBuffer)
into {ch, data} frames over one connection per tab, replacing the two SSE
endpoints. live frames are code-tagged so one socket can carry 0..N codes.
Data sources are unchanged — this is a wire-transport layer only.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
from collections.abc import Callable

from fastapi import APIRouter, WebSocket

from hoga.api.events import EventBus
from hoga.live.buffer import LiveBuffer

logger = logging.getLogger(__name__)

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


def build_ws_router(  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    bus: EventBus,
    get_buffer: Callable[[], LiveBuffer | None],
    *,
    ping_timeout_s: float = _PING_TIMEOUT_S,
) -> APIRouter:
    router = APIRouter()

    @router.websocket("/api/ws")
    async def _ws(websocket: WebSocket) -> None:  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
        await websocket.accept()
        # ADR-0067: local import to avoid circular imports at module level.
        # Placed here so both receiver() closure and finally block can access it.
        from hoga.live import lifecycle  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
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
                except TimeoutError:
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
        finally:
            # 이 블록은 **이 태스크가 취소된 상태로** 진입할 수 있다(ASGI 서버 종료,
            # TestClient teardown). 그때는 여기서 하는 첫 await 가 즉시 취소를 다시
            # 받는다 — 취소는 스코프가 끝날 때까지 재전달되기 때문이다. 그러니
            # **동기 정리를 전부 await 앞에 둔다**. 순서를 되돌리면 취소 경로에서
            # bus/버퍼 구독이 통째로 샌다(이전 판의 실제 결함).
            for t in (send_task, recv_task, bus_task):
                t.cancel()
            subs = list(code_subs.items())
            for _code, (_q, task, _v) in subs:
                task.cancel()
            bus.unsubscribe(bus_q)
            buf = get_buffer()
            if buf is not None:
                for code, (q, _task, _v) in subs:
                    buf.unsubscribe(code, q)
            # 남은 정리는 await 가 필요하다. 취소 중이면 첫 await 에서 끊기므로
            # 여기서 삼킨다 — 삼켜도 try 본문의 취소는 finally 종료와 함께 그대로
            # 전파되므로 태스크 경계에서 취소를 감추지 않는다. 취소를 감추면
            # anyio 취소 스코프의 uncancel 회계가 어긋나 CancelledError 가 ASGI
            # 호출자 밖으로 새어 나간다(차단 게이트 위 flake 의 원인이었다).
            with contextlib.suppress(asyncio.CancelledError):
                await asyncio.gather(
                    send_task, recv_task, bus_task,
                    *(task for _code, (_q, task, _v) in subs),
                    return_exceptions=True,
                )
                # ADR-0067/PR-C: ghost-polling prevention — unsubscribe all subscribed
                # codes from the REST poller + 키움 표시셋 lifecycle on disconnect.
                for code, (_q, _task, venues) in subs:
                    await lifecycle.on_view_unsubscribe(code, venues, ref=view_ref)

    return router
