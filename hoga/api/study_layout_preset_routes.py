from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import study_layout_presets
from hoga.api.layout_preset_store import PresetConflictError, PresetNotFoundError
from hoga.api.models import (
    StudyLayoutPreset,
    StudyLayoutPresetListRow,
    StudyLayoutPresetsFile,
    StudyLayoutPresetWriteRequest,
)

log = logging.getLogger(__name__)

# `/live` 라우터와 동형이다(같은 CRUD·같은 404/409 계약). 에러 코드만 리소스별로
# 구분해 클라이언트가 어느 프리셋 목록을 다시 읽어야 하는지 알 수 있게 한다.


def _not_found(preset_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "study_layout_preset_not_found",
            "message": f"study layout preset not found: {preset_id}",
        },
    )


def _conflict(e: PresetConflictError) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "study_layout_preset_conflict",
            "message": (
                "study layout preset changed elsewhere: "
                f"expected updated_at_ms={e.expected_ms}, actual={e.actual_ms}"
            ),
        },
    )


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/study-layout-presets", tags=["study-layout-presets"])

    @router.get("", response_model=StudyLayoutPresetsFile)
    async def list_presets() -> StudyLayoutPresetsFile:
        return study_layout_presets.load_presets(data_dir)

    @router.post("", status_code=201, response_model=StudyLayoutPresetListRow)
    async def create_preset(req: StudyLayoutPresetWriteRequest) -> StudyLayoutPreset:
        return await study_layout_presets.create_preset(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=int(time.time() * 1000),
        )

    @router.put("/{preset_id}", response_model=StudyLayoutPresetListRow)
    async def update_preset(
        preset_id: str, req: StudyLayoutPresetWriteRequest
    ) -> StudyLayoutPreset:
        try:
            return await study_layout_presets.update_preset(
                data_dir,
                id=preset_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except PresetNotFoundError as e:
            raise _not_found(preset_id) from e
        except PresetConflictError as e:
            raise _conflict(e) from e

    @router.delete("/{preset_id}", status_code=204)
    async def delete_preset(preset_id: str) -> None:
        try:
            await study_layout_presets.delete_preset(data_dir, id=preset_id)
        except PresetNotFoundError as e:
            raise _not_found(preset_id) from e

    return router
