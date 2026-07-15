from __future__ import annotations

import asyncio
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    LiveLayoutPreset,
    LiveLayoutPresetListRow,
    LiveLayoutPresetsFile,
    LiveLayoutPresetWriteRequest,
)
from hoga.api.versioned_json_file import load_versioned_json_file

# 화면 구성 프리셋 저장소 — study_views 와 동일한 versioned-JSON-manifest 패턴
# (asyncio.Lock + load_versioned_json_file + atomic_write_json). ADR-0114 §4.
_CURRENT_VERSION = 1
_lock = asyncio.Lock()


class LiveLayoutPresetNotFoundError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "live_layout_presets"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def load_presets(data_dir: Path) -> LiveLayoutPresetsFile:
    return load_versioned_json_file(
        _manifest_path(data_dir),
        model=LiveLayoutPresetsFile,
        current_version=_CURRENT_VERSION,
        empty_factory=LiveLayoutPresetsFile,
    )


def save_presets(data_dir: Path, file: LiveLayoutPresetsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def _preset_from_req(
    *,
    req: LiveLayoutPresetWriteRequest,
    id: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> LiveLayoutPreset:
    return LiveLayoutPreset(
        id=id,
        name=req.name,
        payload=req.payload,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def list_presets_sync(data_dir: Path) -> list[LiveLayoutPresetListRow]:
    return load_presets(data_dir).presets


def create_preset_sync(
    data_dir: Path, *, req: LiveLayoutPresetWriteRequest, id: str, now_ms: int
) -> LiveLayoutPreset:
    file = load_presets(data_dir)
    preset = _preset_from_req(req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
    file.presets.append(preset)
    file.presets.sort(key=lambda p: p.updated_at_ms, reverse=True)
    save_presets(data_dir, file)
    return preset


def update_preset_sync(
    data_dir: Path, *, id: str, req: LiveLayoutPresetWriteRequest, now_ms: int
) -> LiveLayoutPreset:
    file = load_presets(data_dir)
    for idx, old in enumerate(file.presets):
        if old.id == id:
            preset = _preset_from_req(
                req=req,
                id=id,
                created_at_ms=old.created_at_ms,
                updated_at_ms=now_ms,
            )
            file.presets[idx] = preset
            file.presets.sort(key=lambda p: p.updated_at_ms, reverse=True)
            save_presets(data_dir, file)
            return preset
    raise LiveLayoutPresetNotFoundError(id)


def delete_preset_sync(data_dir: Path, *, id: str) -> None:
    file = load_presets(data_dir)
    if not any(p.id == id for p in file.presets):
        raise LiveLayoutPresetNotFoundError(id)
    file.presets = [p for p in file.presets if p.id != id]
    save_presets(data_dir, file)


async def create_preset(
    data_dir: Path, *, req: LiveLayoutPresetWriteRequest, id: str, now_ms: int
) -> LiveLayoutPreset:
    async with _lock:
        return create_preset_sync(data_dir, req=req, id=id, now_ms=now_ms)


async def update_preset(
    data_dir: Path, *, id: str, req: LiveLayoutPresetWriteRequest, now_ms: int
) -> LiveLayoutPreset:
    async with _lock:
        return update_preset_sync(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_preset(data_dir: Path, *, id: str) -> None:
    async with _lock:
        delete_preset_sync(data_dir, id=id)
