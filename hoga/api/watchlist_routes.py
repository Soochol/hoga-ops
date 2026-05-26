"""FastAPI router for /api/watchlist.

See spec docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import symbols
from hoga.api.models import (
    WatchlistAddRequest,
    WatchlistEntry,
    WatchlistResponse,
)
from hoga.api.scheduler import seconds_until_next_18_kst
from hoga.api.watchlist import (
    AlreadyInWatchlistError,
    NotInWatchlistError,
    add_entry,
    load_watchlist,
    remove_entry,
)
from hoga.collector.orchestrator import now_kst


def _next_run_at_ms(now: dt.datetime) -> int:
    secs = seconds_until_next_18_kst(now)
    target = now + dt.timedelta(seconds=secs)
    return int(target.timestamp() * 1000)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        return WatchlistResponse(
            entries=load_watchlist(data_dir),
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )

    @router.post("", status_code=201, response_model=WatchlistEntry)
    async def add_to_watchlist(req: WatchlistAddRequest) -> WatchlistEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            raise HTTPException(status_code=400, detail={
                "code": "unknown_code",
                "message": f"Code {req.code} is not in the symbol master.",
            })
        today = now_kst().strftime("%Y%m%d")
        try:
            entry = await add_entry(
                data_dir, code=req.code, name=match.name, today_kst_date=today,
            )
        except AlreadyInWatchlistError as e:
            raise HTTPException(status_code=409, detail={
                "code": "already_in_watchlist",
                "message": f"Code {req.code} is already in the Watchlist.",
            }) from e
        return entry

    @router.delete("/{code}", status_code=204)
    async def remove_from_watchlist(code: str) -> None:
        if not code.isdigit() or len(code) != 6:
            raise HTTPException(status_code=400, detail={
                "code": "invalid_code", "message": "Code must be 6 digits.",
            })
        try:
            await remove_entry(data_dir, code=code)
        except NotInWatchlistError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            }) from e

    return router
