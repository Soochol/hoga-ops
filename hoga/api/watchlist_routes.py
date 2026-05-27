"""FastAPI router for /api/watchlist.

See spec docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.
"""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path as PathParam

# 6-digit numeric KRX code — see models.WatchlistEntry.code, which uses the
# same pattern on the body/response shape. Centralised here so the four
# routes that take {code} in the path don't each re-implement isdigit/len.
CodePathParam = Annotated[str, PathParam(pattern=r"^\d{6}$")]

from hoga.api import symbols
from hoga.api.models import (
    EnqueueResponse,
    ManualCatchupAllEntryResult,
    ManualCatchupAllResponse,
    WatchlistAddRequest,
    WatchlistEntry,
    WatchlistResponse,
)
from hoga.api.scheduler import catchup_one_entry, seconds_until_next_18_kst
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

    @router.post("/catchup", response_model=ManualCatchupAllResponse)
    async def catchup_all() -> ManualCatchupAllResponse:
        now = now_kst()
        results: list[ManualCatchupAllEntryResult] = []
        for entry in load_watchlist(data_dir):
            try:
                resp = await catchup_one_entry(
                    entry, data_dir=data_dir, now=now,
                )
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=len(resp.enqueued),
                    deduped_count=len(resp.deduped),
                    error=None,
                ))
            except Exception as e:  # noqa: BLE001 — one bad entry mustn't kill the run
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=str(e) or e.__class__.__name__,
                ))
        return ManualCatchupAllResponse(results=results)

    @router.delete("/{code}", status_code=204)
    async def remove_from_watchlist(code: CodePathParam) -> None:
        try:
            await remove_entry(data_dir, code=code)
        except NotInWatchlistError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            }) from e

    @router.post("/{code}/catchup", response_model=EnqueueResponse)
    async def catchup_one(code: CodePathParam) -> EnqueueResponse:
        entries = load_watchlist(data_dir)
        match = next((e for e in entries if e.code == code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            })
        return await catchup_one_entry(
            match, data_dir=data_dir, now=now_kst(),
        )

    return router
