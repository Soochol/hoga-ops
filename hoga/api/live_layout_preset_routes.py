from __future__ import annotations

import logging
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, HTTPException

from hoga.api import live_layout_presets
from hoga.api.events import EventBus
from hoga.api.layout_preset_store import PresetConflictError, PresetNotFoundError
from hoga.api.models import (
    LiveLayoutPreset,
    LiveLayoutPresetListRow,
    LiveLayoutPresetsFile,
    LiveLayoutPresetWriteRequest,
)
from hoga.api.mutation_broadcast import mutation_broadcast_route_class

log = logging.getLogger(__name__)


def _not_found(preset_id: str) -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={
            "code": "live_layout_preset_not_found",
            "message": f"live layout preset not found: {preset_id}",
        },
    )


def _conflict(e: PresetConflictError) -> HTTPException:
    return HTTPException(
        status_code=409,
        detail={
            "code": "live_layout_preset_conflict",
            "message": (
                "live layout preset changed elsewhere: "
                f"expected updated_at_ms={e.expected_ms}, actual={e.actual_ms}"
            ),
        },
    )


def build_router(*, data_dir: Path, bus: EventBus | None = None) -> APIRouter:
    router = APIRouter(
        prefix="/api/live-layout-presets",
        tags=["live-layout-presets"],
        # 저장뷰와 같은 전면 브로드캐스트(mutation_broadcast) — 이 라우터는 전부
        # 프리셋 CRUD 라 스크리너처럼 조회성 변경 메서드가 섞여 있지 않다.
        route_class=mutation_broadcast_route_class(bus, "live_layout_presets_changed"),
    )

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
        except PresetNotFoundError as e:
            raise _not_found(preset_id) from e
        except PresetConflictError as e:
            raise _conflict(e) from e

    @router.delete("/{preset_id}", status_code=204)
    async def delete_preset(preset_id: str) -> None:
        try:
            await live_layout_presets.delete_preset(data_dir, id=preset_id)
        except PresetNotFoundError as e:
            raise _not_found(preset_id) from e

    return router
