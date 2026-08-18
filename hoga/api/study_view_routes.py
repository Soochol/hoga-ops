from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import study_views
from hoga.api.events import EventBus
from hoga.api.models import (
    StudyViewListRow,
    StudyViewMetadataUpdateRequest,
    StudyViewReferenceWriteRequest,
    StudyViewsFile,
)
from hoga.api.mutation_broadcast import mutation_broadcast_route_class

log = logging.getLogger(__name__)

# `OnReferenceSaved` 훅은 제거됐다(2026-08-07). 유일한 소비자가 저장뷰 캡처-공백
# 캔들 복구였고, 그 기능을 `kis_api` 네임스페이스와 함께 접었다 — 복구본이 메우던
# 것은 캔들뿐이고 캔들은 벤더가 과거를 다시 준다(`sources.SourceName` 주석).


def _not_found(save_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "study_view_not_found",
            "message": f"study view not found: {save_id}",
        },
    )


def build_router(*, data_dir: Path, bus: EventBus | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/api/study-views",
        tags=["study-views"],
        # 관심목록·히트맵과 같은 교차 창 브로드캐스트(mutation_broadcast). 이 라우터는
        # 전부 저장 CRUD 라 스크리너처럼 서브라우터를 쪼갤 이유가 없다 — 조회성
        # 변경 메서드가 섞여 있지 않다.
        route_class=mutation_broadcast_route_class(bus, "study_views_changed"),
    )

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
        return save

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await study_views.delete_save(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    return router
