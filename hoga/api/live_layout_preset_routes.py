from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import live_layout_presets
from hoga.api.models import (
    LiveLayoutPreset,
    LiveLayoutPresetListRow,
    LiveLayoutPresetsFile,
    LiveLayoutPresetWriteRequest,
)

log = logging.getLogger(__name__)


def _not_found(preset_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "live_layout_preset_not_found",
            "message": f"live layout preset not found: {preset_id}",
        },
    )


def build_router(*, data_dir: Path) -> APIRouter:
    router = APIRouter(prefix="/api/live-layout-presets", tags=["live-layout-presets"])

    @router.get("", response_model=LiveLayoutPresetsFile)
    async def list_presets() -> LiveLayoutPresetsFile:
        return live_layout_presets.load_presets(data_dir)

    @router.post("", status_code=201, response_model=LiveLayoutPresetListRow)
    async def create_preset(req: LiveLayoutPresetWriteRequest) -> LiveLayoutPreset:
        now_ms = int(time.time() * 1000)
        return await live_layout_presets.create_preset(
            data_dir,
            req=req,
            id=uuid.uuid4().hex,
            now_ms=now_ms,
        )

    @router.put("/{preset_id}", response_model=LiveLayoutPresetListRow)
    async def update_preset(
        preset_id: str, req: LiveLayoutPresetWriteRequest
    ) -> LiveLayoutPreset:
        try:
            return await live_layout_presets.update_preset(
                data_dir,
                id=preset_id,
                req=req,
                now_ms=int(time.time() * 1000),
            )
        except live_layout_presets.LiveLayoutPresetNotFoundError as e:
            raise _not_found(preset_id) from e

    @router.delete("/{preset_id}", status_code=204)
    async def delete_preset(preset_id: str) -> None:
        try:
            await live_layout_presets.delete_preset(data_dir, id=preset_id)
        except live_layout_presets.LiveLayoutPresetNotFoundError as e:
            raise _not_found(preset_id) from e

    return router
