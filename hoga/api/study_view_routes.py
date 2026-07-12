from __future__ import annotations

import logging
import time
import uuid
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import study_views
from hoga.api.models import (
    StudyViewListRow,
    StudyViewMetadataUpdateRequest,
    StudyViewReference,
    StudyViewReferenceWriteRequest,
    StudyViewsFile,
)

log = logging.getLogger(__name__)

# 저장뷰가 생성/갱신될 때 호출되는 훅. 앱은 여기에 KIS 분봉 캡처-공백 복구를
# 건다(:mod:`hoga.live.candle_repair`). study_views 계층은 KIS를 몰라도 되도록
# 콜백으로 주입한다 — 실패는 저장을 절대 깨지 않는다(격리 try/except).
OnReferenceSaved = Callable[[StudyViewReference], None]


def _not_found(save_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "study_view_not_found",
            "message": f"study view not found: {save_id}",
        },
    )


def build_router(
    *, data_dir: Path, on_reference_saved: OnReferenceSaved | None = None
) -> APIRouter:
    router = APIRouter(prefix="/api/study-views", tags=["study-views"])

    def _notify_saved(save: StudyViewReference) -> None:
        if on_reference_saved is None:
            return
        try:
            on_reference_saved(save)
        except Exception:
            # 복구 스케줄 실패가 저장 응답을 깨면 안 된다 — 저장은 이미 성공했다.
            log.exception("on_reference_saved hook failed id=%s", save.id)

    @router.get("/saves", response_model=StudyViewsFile)
    async def list_saves() -> StudyViewsFile:
        return study_views.load_saves(data_dir)

    @router.post("/saves", status_code=201, response_model=StudyViewListRow)
    async def create_save(req: StudyViewReferenceWriteRequest) -> StudyViewListRow:
        now_ms = int(time.time() * 1000)
        save = await study_views.create_save(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=now_ms,
        )
        _notify_saved(save)
        return save

    @router.get("/saves/{save_id}", response_model=StudyViewListRow)
    async def get_save(save_id: str) -> StudyViewListRow:
        try:
            return study_views.get_save_sync(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.patch("/saves/{save_id}/metadata", response_model=StudyViewListRow)
    async def update_save_metadata(
        save_id: str, req: StudyViewMetadataUpdateRequest
    ) -> StudyViewListRow:
        try:
            return await study_views.update_save_metadata(
                data_dir,
                id=save_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.put("/saves/{save_id}", response_model=StudyViewListRow)
    async def update_save(
        save_id: str, req: StudyViewReferenceWriteRequest
    ) -> StudyViewListRow:
        try:
            now_ms = int(time.time() * 1000)
            save = await study_views.update_save(
                data_dir,
                id=save_id,
                req=req,
                now_ms=now_ms,
            )
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e
        _notify_saved(save)
        return save

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await study_views.delete_save(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    return router
