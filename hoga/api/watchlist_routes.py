"""FastAPI router for /api/watchlist.

See spec docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path

from fastapi import APIRouter

from hoga.api.models import WatchlistResponse
from hoga.api.scheduler import seconds_until_next_18_kst
from hoga.api.watchlist import load_watchlist
from hoga.collector.orchestrator import now_kst


def _next_run_at_ms(now: dt.datetime) -> int:
    secs = seconds_until_next_18_kst(now)
    target = now + dt.timedelta(seconds=secs)
    return int(target.timestamp() * 1000)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        wl = load_watchlist(data_dir)
        return WatchlistResponse(
            entries=wl.entries,
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )

    return router
