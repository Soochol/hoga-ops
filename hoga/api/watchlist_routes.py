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

from hoga.api import symbols
from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.events import EventBus
from hoga.api.models import (
    EnqueueResponse,
    EntriesRemoveRequest,
    EntriesReorderRequest,
    FolderCreateRequest,
    FolderRenameRequest,
    FolderReorderRequest,
    ItemsReorderRequest,
    ManualCatchupAllEntryResult,
    ManualCatchupAllResponse,
    ManualCatchupError,
    MemberAddRequest,
    MemoCreateRequest,
    MemoUpdateRequest,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolderView,
    WatchlistMemoView,
    WatchlistResponse,
)
from hoga.api.mutation_broadcast import mutation_broadcast_route_class
from hoga.api.params import CODE_PATTERN
from hoga.api.scheduler import catchup_one_entry, next_run_at_ms
from hoga.api.watchlist import (
    FolderNotFoundError,
    MemoNotFoundError,
    NotInWatchlistError,
    WatchlistSetMismatchError,
    add_member,
    add_memo,
    create_folder,
    delete_folder,
    load_document,
    load_watchlist,
    remove_entries,
    remove_entry,
    remove_member,
    remove_memo,
    rename_folder,
    reorder_entries,
    reorder_folders,
    reorder_items,
    update_memo,
)
from hoga.api.watchlist_projection import project_watchlist_response
from hoga.collector.orchestrator import now_kst
from hoga.live.lifecycle import refresh_live_stream

log = logging.getLogger(__name__)

# KRX code — params.CODE_PATTERN is the single source of the ticker grammar
# (6-char alphanumeric + 7-char Q-prefixed ETN).
#
# import 블록 **아래** 에 둔다. 위(중간)에 있으면 그 뒤 import 전부가 E402
# "module level import not at top of file" 로 잡힌다 — 별칭 한 줄이 8건을 만들었다.
CodePathParam = Annotated[str, PathParam(pattern=CODE_PATTERN)]


def _next_run_at_ms(now: dt.datetime) -> int:
    # 계산 본체는 scheduler.next_run_at_ms — 히트맵 라우트도 같은 함수를 쓴다
    # (ADR-0142: 하나의 일일 런이 두 목록을 적재하므로 두 화면의 값이 같아야 한다).
    return next_run_at_ms(now)


def _project(doc: WatchlistDocument, *, next_run_at_ms: int) -> WatchlistResponse:
    """Store doc (folders own member_codes + slim entries) → wire WatchlistResponse
    (folders {id,name,order} + entries EXPLODED to one (folder, code) row each;
    a multi-folder Code appears once per folder). Backend projection, no client
    adapter (ADR-0004/0070 option B). Drift (a member with no entry) is logged
    loudly and skipped — never crashes the read (ADR-0065)."""
    return project_watchlist_response(doc, next_run_at_ms=next_run_at_ms)


def build_router(  # noqa: PLR0915 — ADR 이 지정한 단일 조립점 — 문장 분할이 설계에 반한다
    *, data_dir: Path, bus: EventBus | None = None,
) -> APIRouter:
    router = APIRouter(
        prefix="/api/watchlist",
        tags=["watchlist"],
        # 변경 라우트가 2xx 로 끝나면 "관심목록이 바뀌었다" 신호를 열려 있는 모든
        # WS 연결에 브로드캐스트한다 — 다른 탭·다른 브라우저가 새로고침 없이 목록을
        # 다시 읽게 하는 유일한 경로다. 라우트마다 손으로 publish 하지 않는 근거와
        # 이 방식이 못 보는 것은 mutation_broadcast 모듈 docstring 에 있다.
        route_class=mutation_broadcast_route_class(bus, "watchlist_changed"),
    )

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
            except Exception:  # one bad entry mustn't kill the run
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
        except Exception:  # stream re-sync is best-effort; the mutation already succeeded
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
        return WatchlistFolderView(
            id=f.id,
            name=f.name,
            order=f.order,
        )

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
        except Exception:  # best-effort, mutation already succeeded
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
        except Exception:  # best-effort, mutation already succeeded
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
                                     today_kst_date=today, folder_id=folder_id, at=req.at)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # best-effort
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
        except Exception:  # best-effort
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
        except Exception:  # best-effort, mutation already succeeded
            log.exception("watchlist.reorder: refresh_live_stream failed")

    @router.put("/folders/{folder_id}/items/order", status_code=204)
    async def reorder_watchlist_items(folder_id: str, req: ItemsReorderRequest) -> None:
        """표시 순서 전체(코드+메모) 재배열 — 패널 dnd 전용(v4).

        `PUT /reorder`(ordered_codes)와 공존한다: 저쪽은 "종목 순서만, 메모는 제자리"
        라 메모를 표시하지 않는 편집 모달의 계약이고, 이쪽은 메모까지 끌 수 있는
        패널의 계약이다.
        """
        keys = [("code", i.code) if i.kind == "code" else ("memo", i.id)
                for i in req.ordered_items]
        try:
            await reorder_items(data_dir, folder_id=folder_id, ordered_keys=keys)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        except WatchlistSetMismatchError as e:
            log.info("watchlist items reorder set mismatch: %s", e)
            raise HTTPException(status_code=409, detail={
                "code": "reorder_set_mismatch",
                "message": "Reorder list does not match the folder's current items."}) from e
        # 아래 메모 CRUD 와 **반대로** 재동기화를 부른다: 코드 순서가 바뀌면 display
        # order 가 바뀌고 그건 Live Set(=WS 구독) 경계를 움직인다(기존 /reorder 와
        # 같은 이유). 메모끼리만 자리를 바꾼 경우도 그냥 부른다 — no-op 재동기화는
        # 싸고, 무엇이 바뀌었는지 diff 하는 것은 과설계다.
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # best-effort, mutation already succeeded
            log.exception("watchlist.items_order: refresh_live_stream failed")

    # --- 메모("빈칸") 아이템 (v4) ---------------------------------------
    # 셋 다 refresh_live_stream 을 부르지 않는다 — 메모는 Code 가 아니라 Live Set
    # 산출(capture_ordered_codes)에 원리적으로 들어가지 않으므로, 부르면 아무것도
    # 바뀌지 않는 WS 재동기화만 낭비한다. (바로 위 items/order 는 반대다 — 거기선
    # 코드 순서가 바뀔 수 있다.)

    @router.post("/folders/{folder_id}/memos", status_code=201,
                 response_model=WatchlistMemoView)
    async def add_folder_memo(folder_id: str, req: MemoCreateRequest) -> WatchlistMemoView:
        try:
            memo, index = await add_memo(data_dir, folder_id=folder_id,
                                         text=req.text, at=req.at)
        except FolderNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "folder_not_found", "message": f"Folder {folder_id} not found."}) from e
        return WatchlistMemoView(id=memo.id, folder_id=folder_id, order=index, text=memo.text)

    @router.patch("/memos/{memo_id}", response_model=WatchlistMemoView)
    async def update_watchlist_memo(memo_id: str, req: MemoUpdateRequest) -> WatchlistMemoView:
        try:
            memo, folder_id, index = await update_memo(data_dir, memo_id=memo_id, text=req.text)
        except MemoNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "memo_not_found", "message": f"Memo {memo_id} not found."}) from e
        return WatchlistMemoView(id=memo.id, folder_id=folder_id, order=index, text=memo.text)

    @router.delete("/memos/{memo_id}", status_code=204)
    async def delete_watchlist_memo(memo_id: str) -> None:
        try:
            await remove_memo(data_dir, memo_id=memo_id)
        except MemoNotFoundError as e:
            raise HTTPException(status_code=404, detail={
                "code": "memo_not_found", "message": f"Memo {memo_id} not found."}) from e

    @router.post("/remove", status_code=204)
    async def bulk_remove_watchlist_entries(req: EntriesRemoveRequest) -> None:
        await remove_entries(data_dir, codes=req.codes)
        try:
            await refresh_live_stream(data_dir=data_dir)
        except Exception:  # best-effort, mutation already succeeded
            log.exception("watchlist.bulk_remove: refresh_live_stream failed")

    return router
