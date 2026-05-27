"""FastAPI router for Live Capture endpoints (spec §6)."""
from __future__ import annotations

from typing import Callable, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .lifecycle import LiveStatus

ControlAction = Literal["start", "stop", "pause"]


class ControlRequest(BaseModel):
    action: ControlAction


def build_router(
    get_status: Callable[[], LiveStatus],
    on_control: Callable[[str], None] | None = None,
) -> APIRouter:
    """Build the /api/live router.

    Args:
        get_status: zero-arg callable returning the current `LiveStatus`.
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

    return router
