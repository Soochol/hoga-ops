"""FastAPI router for /api/heatmap.

The Heatmap is an independent monitoring list (ADR-0068). This router mirrors
/api/watchlist's folder/entry CRUD but deliberately OMITS the catch-up routes:
since ADR-0142 the heatmap IS a daily capture target, but catch-up is same-day
only and the 17:00 run already covers it — a per-row "collect today" button
would just race the scheduler. Past gaps go through the 수집 다이얼로그.

``next_run_at_ms`` IS served (ADR-0142) — the same 17:00 KST boundary the
watchlist reports, because one daily run now enqueues both lists.

Heatmap codes also feed the Kiwoom WS storage set (ADR-0116/0118), so every
route that can change the entry SET calls ``refresh_live_stream`` to resync
storage targets — including delete-folder, which since v3 (ADR-0112) deletes
the folder's member entries too. Folder-shape routes (rename/reorder/move)
leave the set intact and stay hook-free.
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

from hoga.api import compute_jobs, symbols
from hoga.api.compute_pools import ComputePools, thread_pools
from hoga.api.events import EventBus
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
from hoga.api.heatmap_group_flow import HeatmapGroupFlowResponse
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
from hoga.api.mutation_broadcast import mutation_broadcast_route_class
from hoga.api.params import CODE_PATTERN
from hoga.api.scheduler import next_run_at_ms
from hoga.live.lifecycle import refresh_live_stream

log = logging.getLogger(__name__)

_KST = ZoneInfo("Asia/Seoul")
# 그룹 흐름 **버스트 합치기** 창(거래일 키).
#
# 이름이 `_FLOW_TTL_MS` 였을 때 주석은 "폴링(60s)마다 재계산하지 않게" 라고 적혀
# 있었다. **그건 이 상수가 할 수 없는 일이다** — 30초는 프론트 폴링 주기(60s,
# frontend/src/api/heatmapGroupFlow.ts)보다 짧아, 단일 클라이언트 정상 상태에서는
# 다음 폴링이 오기 전에 항상 만료된다. 즉 폴링 경로에서는 한 번도 히트하지 않는다.
#
# 실제로 막아 주는 것은 이 창 안에 **몰리는** 요청이다: 탭 여러 개 동시 열기,
# 새로고침 연타, 페이지 재진입. 아래 "확인 → 락 → 재확인" 이 그 single-flight
# 이고, 그게 이 블록에서 유일하게 load-bearing 한 부분이다. 락이 없으면 동시
# 탭 N개가 947MB JSONL 읽기를 N번 동시에 돌린다.
#
# **값을 올리지 않는 이유**: 폴링당 재계산까지 없애려면 창을 60초 위로 올려야
# 하는데, 그건 신선도를 판다. 스파크라인의 **마지막 버킷은 계속 움직인다**
# (_code_bucket_pct 가 진행 중인 5분 칸에도 carry-forward 값을 넣는다). 즉
# 오른쪽 끝 점이 창 길이만큼 뒤처지고, 장이 움직이는 날엔 눈에 띈다.
# "버킷이 5분이니 150초까지는 안 보인다" 는 틀린 추론이다 — 칸 경계만 5분이지
# 마지막 칸의 값은 실시간에 가깝다.
#
# **값을 내리지도 않는 이유**: 재계산 비용은 2026-07-29 에 이미 4.6배 줄었다
# (_read_candle_closes 의 candle 프리필터, 실측 243파일 947MB 기준 11.67s →
# 2.52s). 60초당 2.5초 = 코어의 약 4% 이고 to_thread 라 이벤트 루프도 안 막는다.
# 30초는 버스트 창으로서 적절하다.
_FLOW_BURST_COALESCE_MS = 30_000
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


def build_router(  # noqa: PLR0915
    *, data_dir: Path, bus: EventBus | None = None, compute: ComputePools | None = None,
) -> APIRouter:
    # 그룹 흐름 계산(JSONL 꼬리 파싱, 순수 파이썬)이 도는 자리(ADR-0169). 안 넘기면
    # 스레드 — 종전 `asyncio.to_thread` 와 같다.
    pools: ComputePools = compute if compute is not None else thread_pools()
    router = APIRouter(
        prefix="/api/heatmap",
        tags=["heatmap"],
        # 관심목록과 같은 브로드캐스트(mutation_broadcast). 두 목록은 독립 스토어라
        # (ADR-0068) 신호도 각자다 — 히트맵 변경이 ['watchlist'] 를 건드리지 않는
        # 프론트 규율이 교차 창 경로에서도 그대로 유지된다.
        route_class=mutation_broadcast_route_class(bus, "heatmap_changed"),
    )

    @router.get("", response_model=HeatmapResponse)
    async def get_heatmap() -> HeatmapResponse:
        doc = load_document(data_dir)
        # next_run_at_ms 는 관심목록과 **같은 함수**를 쓴다(ADR-0142: 하나의 17:00 런이
        # 두 목록을 함께 적재하므로 두 화면이 다른 시각을 말하면 그 자체로 버그다).
        return HeatmapResponse(
            folders=_folder_views(doc.folders),
            entries=doc.entries,
            capture_markers=doc.capture_markers,
            next_run_at_ms=next_run_at_ms(dt.datetime.now(tz=ZoneInfo("Asia/Seoul"))),
        )

    @router.get("/group-flow", response_model=HeatmapGroupFlowResponse)
    async def get_heatmap_group_flow(
        date: str | None = Query(default=None, description="거래일 YYYYMMDD. 미지정=오늘(KST)."),
        # 셀이 venue 별 시세이므로 그룹 흐름도 같은 venue 를 읽어야 한다(ADR-0140).
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
        # ⚠ 캐시 키에 venue 가 있어야 한다 — 없으면 첫 요청의 venue 결과가
        # 다른 venue 요청에 그대로 돌아간다(버스트 병합 창 안에서).
        key = (str(data_dir), basis.strftime("%Y%m%d"), venue)
        now_ms = int(time.time() * 1000)
        cached, at = _flow_cache.get(key), _flow_cache_at.get(key)
        if cached is not None and at is not None and now_ms - at <= _FLOW_BURST_COALESCE_MS:
            return cached
        async with _flow_lock:
            # 락 재확인(다른 코루틴이 방금 채웠을 수 있음).
            cached, at = _flow_cache.get(key), _flow_cache_at.get(key)
            if cached is not None and at is not None and now_ms - at <= _FLOW_BURST_COALESCE_MS:
                return cached
            resp = await compute_jobs.run_job(
                pools.wide, compute_jobs.group_flow_job, str(data_dir), basis, now_ms, venue,
            )
            _flow_cache[key] = resp
            _flow_cache_at[key] = now_ms
            return resp

    @router.delete("/{code}", status_code=204)
    async def remove_from_heatmap(code: CodePathParam) -> None:
        """Unregister the code from EVERY group. The per-group surface is
        DELETE /folders/{folder_id}/members/{code} — that is what the UI row
        menu calls, since a code may now be registered in several groups."""
        try:
            await remove_entry(data_dir, code=code)
        except NotInHeatmapError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_heatmap",
                "message": f"Code {code} is not in the Heatmap.",
            }) from e
        await _refresh_storage_targets(data_dir, op="remove")

    @router.delete("/folders/{folder_id}/members/{code}", status_code=204)
    async def remove_heatmap_folder_member(folder_id: str, code: CodePathParam) -> None:
        """Unregister the code from THIS group only — its registrations in
        other groups stand."""
        try:
            await remove_entry(data_dir, code=code, folder_id=folder_id)
        except NotInHeatmapError as e:
            raise HTTPException(status_code=404, detail={
                "code": "not_in_heatmap",
                "message": f"Code {code} is not in heatmap folder {folder_id}.",
            }) from e
        await _refresh_storage_targets(data_dir, op="remove_member")

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
        """Move registrations from one group to another. No storage resync: the
        code SET is unchanged (move never adds or drops a code, only its group
        membership) — unlike add/remove, which do change the set (ADR-0097)."""
        try:
            await move_entries(data_dir, codes=req.codes,
                               from_folder_id=req.from_folder_id, folder_id=req.folder_id)
        except FolderNotFoundError as e:
            # e.args[0] 은 실제로 없는 쪽(source 일 수도, target 일 수도) — 요청의
            # folder_id 를 그대로 쓰면 source 가 없는 경우 틀린 id 를 안내한다.
            missing = e.args[0] if e.args else req.folder_id
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found",
                "message": f"Folder {missing} not found."}) from e

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
