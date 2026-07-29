from __future__ import annotations

from pathlib import Path

from hoga.api.layout_preset_store import PresetStore
from hoga.api.models import (
    StudyLayoutPreset,
    StudyLayoutPresetListRow,
    StudyLayoutPresetsFile,
    StudyLayoutPresetWriteRequest,
)

# `/study` 레이아웃 프리셋 — 저장소 뼈대는 layout_preset_store 가 갖고(=`/live` 와 같은
# 코드), 여기선 리소스 고유값만 묶는다. payload 는 **창 배치만**이라 `/live` 와 목록을
# 공유하지 않는다(별도 루트·별도 매니페스트).
#
# v1 — 첫 버전이라 폐기할 구 형식이 없다.
_CURRENT_VERSION = 1

_store: PresetStore[StudyLayoutPreset, StudyLayoutPresetsFile] = PresetStore(
    root_name="study_layout_presets",
    current_version=_CURRENT_VERSION,
    preset_model=StudyLayoutPreset,
    file_model=StudyLayoutPresetsFile,
)


def _manifest_path(data_dir: Path) -> Path:
    return _store.manifest_path(data_dir)


def load_presets(data_dir: Path) -> StudyLayoutPresetsFile:
    return _store.load(data_dir)


def save_presets(data_dir: Path, file: StudyLayoutPresetsFile) -> None:
    _store.save(data_dir, file)


def list_presets_sync(data_dir: Path) -> list[StudyLayoutPresetListRow]:
    return _store.list_sync(data_dir)


def create_preset_sync(
    data_dir: Path, *, req: StudyLayoutPresetWriteRequest, id: str, now_ms: int
) -> StudyLayoutPreset:
    return _store.create_sync(data_dir, req=req, id=id, now_ms=now_ms)


def update_preset_sync(
    data_dir: Path, *, id: str, req: StudyLayoutPresetWriteRequest, now_ms: int
) -> StudyLayoutPreset:
    return _store.update_sync(data_dir, id=id, req=req, now_ms=now_ms)


def delete_preset_sync(data_dir: Path, *, id: str) -> None:
    _store.delete_sync(data_dir, id=id)


async def create_preset(
    data_dir: Path, *, req: StudyLayoutPresetWriteRequest, id: str, now_ms: int
) -> StudyLayoutPreset:
    return await _store.create(data_dir, req=req, id=id, now_ms=now_ms)


async def update_preset(
    data_dir: Path, *, id: str, req: StudyLayoutPresetWriteRequest, now_ms: int
) -> StudyLayoutPreset:
    return await _store.update(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_preset(data_dir: Path, *, id: str) -> None:
    await _store.delete(data_dir, id=id)
