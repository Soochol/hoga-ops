"""FastAPI router for /api/watchlist.

See spec docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.
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
# (6-char alphanumeric + 7-char Q-prefixed ETN). models.WatchlistEntry.code
# uses the same pattern on the body/response shape.
CodePathParam = Annotated[str, PathParam(pattern=CODE_PATTERN)]

from hoga.api import symbols
from hoga.api.models import (
    EnqueueResponse,
    EntriesMoveRequest,
    EntriesRemoveRequest,
    EntriesReorderRequest,
    FolderCreateRequest,
    FolderRenameRequest,
    FolderReorderRequest,
    ManualCatchupAllEntryResult,
    ManualCatchupAllResponse,
    ManualCatchupError,
    WatchlistAddRequest,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistResponse,
)
from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.scheduler import catchup_one_entry, seconds_until_next_17_kst
from hoga.api.watchlist import (
    AlreadyInWatchlistError,
    FolderNotFoundError,
    NotInWatchlistError,
    WatchlistSetMismatchError,
    add_entry,
    create_folder,
    delete_folder,
    load_document,
    load_watchlist,
    move_entries,
    remove_entries,
    remove_entry,
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


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/watchlist", tags=["watchlist"])

    @router.get("", response_model=WatchlistResponse)
    async def get_watchlist() -> WatchlistResponse:
        doc = load_document(data_dir)
        return WatchlistResponse(
            folders=doc.folders,
            entries=doc.entries,
            next_run_at_ms=_next_run_at_ms(now_kst()),
        )

    @router.post("", status_code=201, response_model=WatchlistEntry)
    async def add_to_watchlist(req: WatchlistAddRequest) -> WatchlistEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            # 404 because the request is well-formed (Pydantic validated the
            # 6-digit pattern) but the referenced resource (symbol-master
            # entry for this code) does not exist. 400 is reserved for
            # malformed requests; Pydantic already returns 422 for those.
            raise HTTPException(status_code=404, detail={
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
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — stream re-sync is best-effort; the watchlist mutation already succeeded
            log.exception("watchlist.add: refresh_live_stream failed code=%s", req.code)
        return entry

    @router.post("/catchup", status_code=201, response_model=ManualCatchupAllResponse)
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
            except TradingDayUnavailableError as e:
                # Map known upstream failures to a stable code the panel
                # can branch on (e.g. show a 'configure KIS_APP_KEY/KIS_APP_SECRET' hint).
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=ManualCatchupError(
                        code=e.code,
                        message="Trading-day list unavailable (KIS).",
                    ),
                ))
            except Exception:  # noqa: BLE001 — one bad entry mustn't kill the run
                # Anything else: log full detail server-side, return a
                # generic stable code. Raw exception strings can leak file
                # paths, credentials, or internal validation messages.
                log.exception(
                    "catchup_all: entry %s/%s failed", entry.code, entry.name,
                )
                results.append(ManualCatchupAllEntryResult(
                    code=entry.code, name=entry.name,
                    enqueued_count=0, deduped_count=0,
                    error=ManualCatchupError(
                        code="catchup_failed",
                        message="Catch-up failed; see server log.",
                    ),
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
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — stream re-sync is best-effort; the watchlist mutation already succeeded
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
            return await catchup_one_entry(
                match, data_dir=data_dir, now=now_kst(),
            )
        except TradingDayUnavailableError as e:
            raise HTTPException(status_code=503, detail={
                "code": e.code,
                "message": "Trading-day list unavailable (KIS).",
            }) from e

    @router.post("/folders", status_code=201, response_model=WatchlistFolder)
    async def create_watchlist_folder(req: FolderCreateRequest) -> WatchlistFolder:
        return await create_folder(data_dir, name=req.name)

    @router.put("/folders/order", status_code=204)
    async def reorder_watchlist_folders(req: FolderReorderRequest) -> None:
        try:
            await reorder_folders(data_dir, ordered_ids=req.ordered_ids)
        except WatchlistSetMismatchError as e:
            log.info("watchlist folder reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "folder_set_mismatch",
                "message": "Folder order list does not match the current folder set."}) from e
        # Live Set = 표시 순서 상위 13 — 폴더 순서 변경은 표시 순서를 바꾼다
        # (최종 리뷰 C1: spec §5.5 '경계 넘기면 구독 스왑'의 누락 후크).
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
        try:
            await delete_folder(data_dir, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        # 폴더 삭제 → 소속 엔트리가 미분류로 이동 = 표시 순서 변경 (리뷰 C1).
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.folder_delete: refresh_live_stream failed")

    @router.post("/move", status_code=204)
    async def move_watchlist_entries(req: EntriesMoveRequest) -> None:
        try:
            await move_entries(data_dir, codes=req.codes, folder_id=req.folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found",
                "message": f"Folder {req.folder_id} not found."}) from e
        # 폴더 간 이동 = 표시 순서 변경 (리뷰 C1).
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # noqa: BLE001 — best-effort, mutation already succeeded
            log.exception("watchlist.move: refresh_live_stream failed")

    @router.put("/reorder", status_code=204)
    async def reorder_watchlist_entries(req: EntriesReorderRequest) -> None:
        try:
            await reorder_entries(data_dir, folder_id=req.folder_id,
                                  ordered_codes=req.ordered_codes)
        except WatchlistSetMismatchError as e:
            log.info("watchlist entry reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "reorder_set_mismatch",
                "message": "Reorder list does not match the folder's current members."}) from e
        # 엔트리 드래그 reorder = spec §5.5의 핵심 상호작용 — 13 경계를 넘으면
        # 구독 스왑이 일어나야 한다 (리뷰 C1; intra-13 reorder는 update_codes의
        # diff early-return으로 wire no-op).
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
