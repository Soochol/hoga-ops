"""FastAPI router for /api/watchlist (v3, ADR-0070).

See spec docs/superpowers/specs/2026-06-11-watchlist-multi-membership-screener-heart-design.md
and 2026-05-26-watchlist-daily-scheduler-design.md.
"""
from __future__ import annotations

import datetime as dt
import logging
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path as PathParam

from hoga.api.params import CODE_PATTERN

log = logging.getLogger(__name__)

# KRX code — params.CODE_PATTERN is the single source of the ticker grammar
# (6-char alphanumeric + 7-char Q-prefixed ETN).
CodePathParam = Annotated[str, PathParam(pattern=CODE_PATTERN)]

from hoga.api import symbols
from hoga.api.models import (
    EnqueueResponse,
    EntriesRemoveRequest,
    EntriesReorderRequest,
    FolderCreateRequest,
    FolderRenameRequest,
    FolderReorderRequest,
    ManualCatchupAllEntryResult,
    ManualCatchupAllResponse,
    ManualCatchupError,
    MemberAddRequest,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistEntryView,
    WatchlistFolderView,
    WatchlistResponse,
)
from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.scheduler import catchup_one_entry, seconds_until_next_17_kst
from hoga.api.watchlist import (
    FolderNotFoundError,
    NotInWatchlistError,
    WatchlistSetMismatchError,
    add_member,
    create_folder,
    delete_folder,
    load_document,
    load_watchlist,
    remove_entries,
    remove_entry,
    remove_member,
    rename_folder,
    reorder_entries,
    reorder_folders,
)
from hoga.collector.orchestrator import now_kst
from hoga.live.lifecycle import refresh_live_stream


def _next_run_at_ms(now: dt.datetime) -> int:
    secs = seconds_until_next_17_kst(now)
    target = now + dt.timedelta(seconds=secs)
    return int(target.timestamp() * 1000)


def _project(doc: WatchlistDocument, *, next_run_at_ms: int) -> WatchlistResponse:
    """Store doc (folders own member_codes + slim entries) → wire WatchlistResponse
    (folders {id,name,order} + entries EXPLODED to one (folder, code) row each;
    a multi-folder Code appears once per folder). Backend projection, no client
    adapter (ADR-0004/0070 option B). Drift (a member with no entry) is logged
    loudly and skipped — never crashes the read (ADR-0065)."""
    by_code = {e.code: e for e in doc.entries}
    entries: list[WatchlistEntryView] = []
    for f in doc.folders:
        for order, code in enumerate(f.member_codes):
            base = by_code.get(code)
            if base is None:
                log.warning("watchlist.drift: member %s in folder %s has no entry (skipped)", code, f.id)
                continue
            entries.append(WatchlistEntryView(
                code=base.code, name=base.name,
                registered_at_kst_date=base.registered_at_kst_date,
                last_success_date=base.last_success_date,
                folder_id=f.id, order=order,
            ))
    folders = [WatchlistFolderView(id=f.id, name=f.name, order=f.order) for f in doc.folders]
    return WatchlistResponse(folders=folders, entries=entries, next_run_at_ms=next_run_at_ms)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        return _project(load_document(data_dir), next_run_at_ms=_next_run_at_ms(now_kst()))

    @router.post("/catchup", status_code=201, response_model=ManualCatchupAllResponse)
    async def catchup_all() -> ManualCatchupAllResponse:
        now = now_kst()
        results: list[ManualCatchupAllEntryResult] = []
        for entry in load_watchlist(data_dir):
            try:
                resp = await catchup_one_entry(entry, data_dir=data_dir, now=now)
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=len(resp.enqueued),
                    deduped_count=len(resp.deduped),
                    error=None,
                ))
            except TradingDayUnavailableError as e:
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=ManualCatchupError(code=e.code, message="Trading-day list unavailable (KIS)."),
                ))
            except Exception:  # noqa: BLE001 — one bad entry mustn't kill the run
                log.exception("catchup_all: entry %s/%s failed", entry.code, entry.name)
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=ManualCatchupError(code="catchup_failed", message="Catch-up failed; see server log."),
                ))
        return ManualCatchupAllResponse(results=results)

    @router.delete("/{code}", status_code=204)
    async def remove_from_watchlist(code: CodePathParam) -> None:
        """Quick-remove: drop the Code from the Watchlist entirely (all folders)."""
        try:
            await remove_entry(data_dir, code=code)
        except NotInWatchlistError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            }) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — stream re-sync is best-effort; the mutation already succeeded
            log.exception("watchlist.remove: refresh_live_stream failed code=%s", code)

    @router.post("/{code}/catchup", status_code=201, response_model=EnqueueResponse)
    async def catchup_one(code: CodePathParam) -> EnqueueResponse:
        entries = load_watchlist(data_dir)
        match = next((e for e in entries if e.code == code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_watchlist",
                "message": f"Code {code} is not in the Watchlist.",
            })
        try:
            return await catchup_one_entry(match, data_dir=data_dir, now=now_kst())
        except TradingDayUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": "Trading-day list unavailable (KIS).",
            }) from e

    @router.post("/folders", status_code=201, response_model=WatchlistFolderView)
    async def create_watchlist_folder(req: FolderCreateRequest) -> WatchlistFolderView:
        f = await create_folder(data_dir, name=req.name)
        return WatchlistFolderView(id=f.id, name=f.name, order=f.order)

    @router.put("/folders/order", status_code=204)
    async def reorder_watchlist_folders(req: FolderReorderRequest) -> None:
        try:
            await reorder_folders(data_dir, ordered_ids=req.ordered_ids)
        except WatchlistSetMismatchError as e:
            log.info("watchlist folder reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "folder_set_mismatch",
                "message": "Folder order list does not match the current folder set."}) from e
        # 폴더 순서 변경은 표시 순서(=Live Set 산출 입력)를 바꾼다.
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.folders_order: refresh_live_stream failed")

    @router.patch("/folders/{folder_id}", status_code=204)
    async def rename_watchlist_folder(folder_id: str, req: FolderRenameRequest) -> None:
        try:
            await rename_folder(data_dir, folder_id=folder_id, name=req.name)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_watchlist_folder(folder_id: str) -> None:
        # v3: destructive — a Code only in this folder leaves the Watchlist (ADR-0070).
        # The UI confirms before an orphaning delete (P6); the server here is the
        # confirmed delete.
        try:
            await delete_folder(data_dir, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.folder_delete: refresh_live_stream failed")

    @router.post("/folders/{folder_id}/members", status_code=201, response_model=WatchlistEntry)
    async def add_folder_member(folder_id: str, req: MemberAddRequest) -> WatchlistEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "unknown_code",
                "message": f"Code {req.code} is not in the symbol master."})
        today = now_kst().strftime("%Y%m%d")
        try:
            entry = await add_member(data_dir, code=req.code, name=match.name,
                                     today_kst_date=today, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort
            log.exception("watchlist.add_member: refresh_live_stream failed code=%s", req.code)
        return entry

    @router.delete("/folders/{folder_id}/members/{code}", status_code=204)
    async def remove_folder_member(folder_id: str, code: CodePathParam) -> None:
        try:
            await remove_member(data_dir, code=code, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort
            log.exception("watchlist.remove_member: refresh_live_stream failed code=%s", code)

    @router.put("/reorder", status_code=204)
    async def reorder_watchlist_entries(req: EntriesReorderRequest) -> None:
        try:
            await reorder_entries(data_dir, folder_id=req.folder_id, ordered_codes=req.ordered_codes)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {req.folder_id} not found."}) from e
        except WatchlistSetMismatchError as e:
            log.info("watchlist entry reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "reorder_set_mismatch",
                "message": "Reorder list does not match the folder's current members."}) from e
        # 그룹 내 reorder = 표시 순서 변경 → W-경계 넘으면 구독 스왑.
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.reorder: refresh_live_stream failed")

    @router.post("/remove", status_code=204)
    async def bulk_remove_watchlist_entries(req: EntriesRemoveRequest) -> None:
        await remove_entries(data_dir, codes=req.codes)
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.bulk_remove: refresh_live_stream failed")

    return router
