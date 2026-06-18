from __future__ import annotations

import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import study_views
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    StudyViewMetadataUpdateRequest,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)


def _not_found(save_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "study_view_not_found",
            "message": f"study view not found: {save_id}",
        },
    )


def _snapshot_integrity(save_id: str, *, code: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": code,
            "message": f"study view snapshot integrity error: {save_id}",
        },
    )


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/study-views", tags=["study-views"])

    @router.get("/saves", response_model=StudyViewsFile)
    async def list_saves() -> StudyViewsFile:
        return study_views.load_saves(data_dir)

    @router.post("/saves", status_code=201, response_model=ParquetStudyView)
    async def create_save(req: ParquetStudyViewWriteRequest) -> ParquetStudyView:
        return await study_views.create_save(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=int(time.time() * 1000),
        )

    @router.get("/saves/{save_id}", response_model=ParquetStudyView)
    async def get_save(save_id: str) -> ParquetStudyView:
        try:
            return study_views.get_save_sync(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.get("/saves/{save_id}/snapshot", response_model=ParquetStudySnapshot)
    async def get_snapshot(save_id: str) -> ParquetStudySnapshot:
        try:
            return study_views.load_restorable_snapshot(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e
        except study_views.StudyViewSnapshotMissingError as e:
            raise _snapshot_integrity(save_id, code="study_view_snapshot_missing") from e
        except study_views.StudyViewSnapshotInvalidError as e:
            raise _snapshot_integrity(save_id, code="study_view_snapshot_invalid") from e

    @router.patch("/saves/{save_id}/metadata", response_model=ParquetStudyView)
    async def update_save_metadata(
        save_id: str, req: StudyViewMetadataUpdateRequest
    ) -> ParquetStudyView:
        try:
            return await study_views.update_save_metadata(
                data_dir,
                id=save_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.put("/saves/{save_id}", response_model=ParquetStudyView)
    async def update_save(
        save_id: str, req: ParquetStudyViewWriteRequest
    ) -> ParquetStudyView:
        try:
            return await study_views.update_save(
                data_dir,
                id=save_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    @router.delete("/saves/{save_id}", status_code=204)
    async def delete_save(save_id: str) -> None:
        try:
            await study_views.delete_save(data_dir, id=save_id)
        except study_views.StudyViewNotFoundError as e:
            raise _not_found(save_id) from e

    return router
