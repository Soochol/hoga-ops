"""FastAPI router for /api/heatmap.

The Heatmap is an independent monitoring list (ADR-0068). This router mirrors
/api/watchlist's folder/entry CRUD but deliberately OMITS:
  - the catch-up routes — the heatmap drives no hogaplay captures;
  - ``next_run_at_ms`` — the heatmap has no scheduler.
Since ADR-0097 the heatmap DOES feed the REST 30s recorder (never the KIS WS
subscription — heatmap codes are REST-only extras), so every route that can
change the entry SET calls ``refresh_live_stream`` to resync storage targets —
including delete-folder, which since v3 (ADR-0112) deletes the folder's member
entries too. Folder-shape routes (rename/reorder/move) leave the set intact
and stay hook-free.
v3 (ADR-0112): there is no 미분류 — the only add surface is the folder-scoped
member add (POST /folders/{id}/members); the folder-less POST "" is gone.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from collections.abc import Iterable
from pathlib import Path
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, HTTPException, Path as PathParam, Query

from hoga.api import symbols
from hoga.api.heatmap import (
    FolderNotFoundError,
    HeatmapSetMismatchError,
    NotInHeatmapError,
    add_entry_to_folder,
    create_folder,
    delete_folder,
    load_document,
    move_entries,
    remove_entries,
    remove_entry,
    rename_folder,
    reorder_entries,
    reorder_folders,
)
from hoga.api.heatmap_group_flow import (
    HeatmapGroupFlowResponse,
    build_group_flow,
)
from hoga.api.models import (
    EntriesRemoveRequest,
    EntriesReorderRequest,
    FolderCreateRequest,
    FolderRenameRequest,
    FolderReorderRequest,
    HeatmapEntriesMoveRequest,
    HeatmapEntry,
    HeatmapFolderView,
    HeatmapResponse,
    MemberAddRequest,
    WatchlistFolder,
)
from hoga.api.params import CODE_PATTERN
from hoga.live.lifecycle import refresh_live_stream

log = logging.getLogger(__name__)

_KST = ZoneInfo("Asia/Seoul")
# 그룹 흐름 TTL 캐시(거래일 키).
#
# 주의 — 이 30초는 프론트 폴링 주기(60s, frontend/src/api/heatmapGroupFlow.ts)
# **보다 짧다**. 즉 단일 클라이언트 정상 상태에서는 다음 폴링이 오기 전에 항상
# 만료되어 캐시가 한 번도 히트하지 않는다. 이 캐시가 실제로 막아 주는 것은
# "폴링마다의 재계산" 이 아니라 30초 안에 몰리는 버스트(탭 여러 개, 수동 새로고침,
# 페이지 재진입)다. 원래 주석은 전자를 막는다고 적혀 있었는데 상수와 어긋났다.
#
# 재계산 비용 자체는 2026-07-29 에 크게 줄었다(_read_candle_closes 의 candle
# 프리필터: 실측 243파일 947MB 기준 11.67s → 2.52s). 60초마다 2.5초면 코어의
# 약 4% 라 상수를 그대로 두었다. 폴링당 재계산까지 없애려면 TTL 을 폴링 주기
# 위로 올려야 하는데, 그건 신선도를 거래하는 결정이라 별도 판단이 필요하다
# (버킷이 5분이므로 150초까지는 시각적으로 드러나지 않는다).
_FLOW_TTL_MS = 30_000
_flow_cache: dict[tuple[str, str], HeatmapGroupFlowResponse] = {}
_flow_cache_at: dict[tuple[str, str], int] = {}
_flow_lock = asyncio.Lock()


async def _refresh_storage_targets(data_dir: Path, *, op: str) -> None:
    """Best-effort storage-target resync after an entry-set mutation (ADR-0097).
    The disk write already committed — a resync failure must not fail the route;
    the next boot/watchlist refresh converges."""
    try:
        await refresh_live_stream(data_dir=data_dir)
    except Exception:
        log.exception("heatmap.%s: refresh_live_stream failed", op)

# KRX code — params.CODE_PATTERN is the single source of the ticker grammar,
# shared with watchlist routes and models.HeatmapEntry.code.
CodePathParam = Annotated[str, PathParam(pattern=CODE_PATTERN)]


def _folder_views(folders: Iterable[WatchlistFolder]) -> list[HeatmapFolderView]:
    return [HeatmapFolderView(id=f.id, name=f.name, order=f.order) for f in folders]


def build_router(*, data_dir: Path) -> APIRouter:  # noqa: PLR0915
    router = APIRouter(prefix="/api/heatmap", tags=["heatmap"])

    @router.get("", response_model=HeatmapResponse)
    async def get_heatmap() -> HeatmapResponse:
        doc = load_document(data_dir)
        return HeatmapResponse(folders=_folder_views(doc.folders), entries=doc.entries)

    @router.get("/group-flow", response_model=HeatmapGroupFlowResponse)
    async def get_heatmap_group_flow(
        date: str | None = Query(default=None, description="거래일 YYYYMMDD. 미지정=오늘(KST)."),
        # venue 는 프론트 계약 호환용(현재 소스는 키움 단일이라 미사용).
        venue: str = Query(default="KRX"),
    ) -> HeatmapGroupFlowResponse:
        now = dt.datetime.now(_KST)
        if date is None:
            basis = now.date()
        else:
            try:
                basis = dt.datetime.strptime(date, "%Y%m%d").date()
            except ValueError as e:
                raise HTTPException(status_code=422, detail={
                    "code": "invalid_date", "message": "date must be YYYYMMDD"}) from e
            if basis > now.date():
                raise HTTPException(status_code=422, detail={
                    "code": "date_in_future", "message": "date is in the future"})
        key = (str(data_dir), basis.strftime("%Y%m%d"))
        now_ms = int(time.time() * 1000)
        cached, at = _flow_cache.get(key), _flow_cache_at.get(key)
        if cached is not None and at is not None and now_ms - at <= _FLOW_TTL_MS:
            return cached
        async with _flow_lock:
            # 락 재확인(다른 코루틴이 방금 채웠을 수 있음).
            cached, at = _flow_cache.get(key), _flow_cache_at.get(key)
            if cached is not None and at is not None and now_ms - at <= _FLOW_TTL_MS:
                return cached
            resp = await asyncio.to_thread(build_group_flow, data_dir, basis, now_ms=now_ms)
            _flow_cache[key] = resp
            _flow_cache_at[key] = now_ms
            return resp

    @router.delete("/{code}", status_code=204)
    async def remove_from_heatmap(code: CodePathParam) -> None:
        try:
            await remove_entry(data_dir, code=code)
        except NotInHeatmapError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_heatmap",
                "message": f"Code {code} is not in the Heatmap.",
            }) from e
        await _refresh_storage_targets(data_dir, op="remove")

    @router.post("/folders", status_code=201, response_model=HeatmapFolderView)
    async def create_heatmap_folder(req: FolderCreateRequest) -> HeatmapFolderView:
        return await create_folder(data_dir, name=req.name)

    @router.post("/folders/{folder_id}/members", status_code=201, response_model=HeatmapEntry)
    async def add_heatmap_folder_member(folder_id: str, req: MemberAddRequest) -> HeatmapEntry:
        hits = symbols.search(req.code, limit=1)
        match = next((h for h in hits if h.code == req.code), None)
        if match is None:
            raise HTTPException(status_code=404, detail={
                "code": "unknown_code",
                "message": f"Code {req.code} is not in the symbol master.",
            })
        try:
            entry = await add_entry_to_folder(
                data_dir,
                code=req.code,
                name=match.name,
                folder_id=folder_id,
            )
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        await _refresh_storage_targets(data_dir, op="add_member")
        return entry

    @router.put("/folders/order", status_code=204)
    async def reorder_heatmap_folders(req: FolderReorderRequest) -> None:
        try:
            await reorder_folders(data_dir, ordered_ids=req.ordered_ids)
        except HeatmapSetMismatchError as e:
            log.info("heatmap folder reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "folder_set_mismatch",
                "message": "Folder order list does not match the current folder set."}) from e

    @router.patch("/folders/{folder_id}", status_code=204)
    async def rename_heatmap_folder(folder_id: str, req: FolderRenameRequest) -> None:
        try:
            await rename_folder(data_dir, folder_id=folder_id, name=req.name)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e

    @router.delete("/folders/{folder_id}", status_code=204)
    async def delete_heatmap_folder(folder_id: str) -> None:
        try:
            await delete_folder(data_dir, folder_id=folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        # v3 (ADR-0112): 폴더 삭제는 멤버 종목도 함께 지우므로 entry SET 이 줄어들 수
        # 있다 → REST 30s 수집 대상 재동기화(ADR-0097). 멤버 0 폴더면 no-op 에 가깝다.
        await _refresh_storage_targets(data_dir, op="delete_folder")

    @router.post("/move", status_code=204)
    async def move_heatmap_entries(req: HeatmapEntriesMoveRequest) -> None:
        try:
            await move_entries(data_dir, codes=req.codes, folder_id=req.folder_id)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found",
                "message": f"Folder {req.folder_id} not found."}) from e

    @router.put("/reorder", status_code=204)
    async def reorder_heatmap_entries(req: EntriesReorderRequest) -> None:
        try:
            await reorder_entries(data_dir, folder_id=req.folder_id,
                                  ordered_codes=req.ordered_codes)
        except HeatmapSetMismatchError as e:
            log.info("heatmap entry reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "reorder_set_mismatch",
                "message": "Reorder list does not match the folder's current members."}) from e

    @router.post("/remove", status_code=204)
    async def bulk_remove_heatmap_entries(req: EntriesRemoveRequest) -> None:
        await remove_entries(data_dir, codes=req.codes)
        await _refresh_storage_targets(data_dir, op="bulk_remove")

    return router
