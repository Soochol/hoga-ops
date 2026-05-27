"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

import asyncio
import json as _json
import time
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sse_starlette.sse import EventSourceResponse

from .buffer import LiveBuffer
from .lifecycle import LiveStatus

if TYPE_CHECKING:
    from .kis_client import KisClient

ControlAction = Literal["start", "stop", "pause"]

# Module-level cache: (code, timeframe) -> (fetched_at_monotonic, list[dict])
_CANDLES_CACHE: dict[tuple[str, str], tuple[float, list[dict]]] = {}
_CANDLES_TTL_SECONDS = 60.0


class ControlRequest(BaseModel):
    action: ControlAction


def build_router(
    get_status: Callable[[], LiveStatus],
    get_buffer: Callable[[], LiveBuffer] | None = None,
    on_control: Callable[[str], None] | None = None,
    get_kis_client: "Callable[[], KisClient | None] | None" = None,
) -> APIRouter:
    """Build the /api/live router.

    Args:
        get_status: zero-arg callable returning the current `LiveStatus`.
        get_buffer: optional zero-arg callable returning the `LiveBuffer`
            singleton. None → /snapshot and /series return 503.
        on_control: optional handler invoked with the action string when
            POST /control is called. None → returns 503 for control requests.
    """
    router = APIRouter(prefix="/api/live")

    @router.get("/status", response_model=LiveStatus)
    async def _get_status() -> LiveStatus:
        return get_status()

    @router.post("/control")
    async def _post_control(req: ControlRequest) -> dict[str, str]:
        if on_control is None:
            raise HTTPException(503, "live control not wired (Stage 8)")
        on_control(req.action)
        return {"action": req.action, "ok": "true"}

    @router.get("/snapshot")
    async def _get_snapshot(code: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        latest = await buf.get_latest(code)
        if latest is None:
            raise HTTPException(404, f"no live data for {code}")
        return latest

    @router.get("/series")
    async def _get_series(code: str, date: str) -> dict:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        series = await buf.get_series(code)
        kst = timezone(timedelta(hours=9))
        dt = datetime.strptime(date, "%Y%m%d").replace(tzinfo=kst)
        session_open_ms = int(dt.replace(hour=9, minute=0).timestamp() * 1000)
        return {
            **series,
            "date": date,
            "session_open_ms": session_open_ms,
            "session_close_ms": None,
            "is_open": True,
        }

    @router.get("/stream")
    async def _get_stream(code: str) -> EventSourceResponse:
        if get_buffer is None:
            raise HTTPException(503, "live buffer not wired")
        buf = get_buffer()
        q = buf.subscribe(code)

        async def stream():
            try:
                while True:
                    try:
                        entry = await asyncio.wait_for(q.get(), timeout=30.0)
                        yield {"event": "live_snapshot", "data": _json.dumps(entry)}
                    except asyncio.TimeoutError:
                        yield {"event": "heartbeat", "data": ""}
            finally:
                buf.unsubscribe(code, q)

        return EventSourceResponse(stream())

    @router.get("/candles")
    async def _get_candles(code: str, timeframe: str = "1m") -> dict:
        if get_kis_client is None:
            raise HTTPException(503, "KIS client not wired")
        kis = get_kis_client()
        if kis is None:
            raise HTTPException(503, "KIS client not initialized")
        valid_timeframes = ("1m", "3m", "5m", "10m", "15m", "30m", "D", "W")
        if timeframe not in valid_timeframes:
            raise HTTPException(422, f"unsupported timeframe: {timeframe}")
        cache_key = (code, timeframe)
        now = time.monotonic()
        cached = _CANDLES_CACHE.get(cache_key)
        if cached is not None and now - cached[0] < _CANDLES_TTL_SECONDS:
            return {"code": code, "timeframe": timeframe, "candles": cached[1], "cached": True}
        candles = await kis.fetch_candles(code, timeframe=timeframe)
        out = [c.model_dump() for c in candles]
        _CANDLES_CACHE[cache_key] = (now, out)
        return {"code": code, "timeframe": timeframe, "candles": out, "cached": False}

    return router
