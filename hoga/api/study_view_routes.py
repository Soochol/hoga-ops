from __future__ import annotations

import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, HTTPException

from hoga.api import study_views
from hoga.api.models import (
    ParquetStudySnapshot,
    StudyViewListRow,
    StudyViewMetadataUpdateRequest,
    StudyViewReferenceWriteRequest,
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


def _snapshot_not_applicable(save_id: str) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "study_view_snapshot_not_applicable",
            "message": f"study view snapshot is not available for reference view: {save_id}",
        },
    )


def _parse_write_request(raw: dict) -> ParquetStudyViewWriteRequest | StudyViewReferenceWriteRequest:
    if "snapshot" in raw:
        return ParquetStudyViewWriteRequest.model_validate(raw)
    return StudyViewReferenceWriteRequest.model_validate(raw)


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/study-views", tags=["study-views"])

    @router.get("/saves", response_model=StudyViewsFile)
    async def list_saves() -> StudyViewsFile:
        return study_views.load_saves(data_dir)

    @router.post("/saves", status_code=201, response_model=StudyViewListRow)
    async def create_save(req_raw: dict = Body(...)) -> StudyViewListRow:
        req = _parse_write_request(req_raw)
        now_ms = int(time.time() * 1000)
        if isinstance(req, StudyViewReferenceWriteRequest):
            return await study_views.create_reference_save(
                data_dir,
                req=req,
                id=uuid.uuid4().hex,
                now_ms=now_ms,
            )
        return await study_views.create_save(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=now_ms,
        )

    @router.get("/saves/{save_id}", response_model=StudyViewListRow)
    async def get_save(save_id: str) -> StudyViewListRow:
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
        except study_views.StudyViewSnapshotNotApplicableError as e:
            raise _snapshot_not_applicable(save_id) from e
        except study_views.StudyViewSnapshotMissingError as e:
            raise _snapshot_integrity(save_id, code="study_view_snapshot_missing") from e
        except study_views.StudyViewSnapshotInvalidError as e:
            raise _snapshot_integrity(save_id, code="study_view_snapshot_invalid") from e

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
        save_id: str, req_raw: dict = Body(...)
    ) -> StudyViewListRow:
        try:
            req = _parse_write_request(req_raw)
            now_ms = int(time.time() * 1000)
            if isinstance(req, StudyViewReferenceWriteRequest):
                return await study_views.update_reference_save(
                    data_dir,
                    id=save_id,
                    req=req,
                    now_ms=now_ms,
                )
            return await study_views.update_save(
                data_dir,
                id=save_id,
                req=req,
                now_ms=now_ms,
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
