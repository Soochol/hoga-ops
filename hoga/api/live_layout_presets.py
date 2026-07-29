from __future__ import annotations

from pathlib import Path

from hoga.api.layout_preset_store import PresetStore
from hoga.api.models import (
    LiveLayoutPreset,
    LiveLayoutPresetListRow,
    LiveLayoutPresetsFile,
    LiveLayoutPresetWriteRequest,
)

# `/live` 레이아웃 프리셋 — 저장소 뼈대는 layout_preset_store 가 갖고, 여기선 리소스
# 고유값(루트·버전·모델)만 묶는다. `/study` 는 study_layout_presets 가 같은 방식으로 얹는다.
#
# v3 (PR-E, #713 §5): payload 가 워크스페이스 전체 스냅샷이다(창·그룹·종목). 구 v1/v2
# 프리셋은 폐기(변환 없음) — 스토어의 stale 버전 가드가 빈 목록으로 대체한다.
_CURRENT_VERSION = 3

_store: PresetStore[LiveLayoutPreset, LiveLayoutPresetsFile] = PresetStore(
    root_name="live_layout_presets",
    current_version=_CURRENT_VERSION,
    preset_model=LiveLayoutPreset,
    file_model=LiveLayoutPresetsFile,
)

# 예외는 스토어의 것을 그대로 쓴다(routes 가 거기서 import). 리소스별 하위 클래스를
# 만들면 스토어가 기반 클래스를 raise 하므로 잡히지 않는다.


def _manifest_path(data_dir: Path) -> Path:
    return _store.manifest_path(data_dir)


def load_presets(data_dir: Path) -> LiveLayoutPresetsFile:
    return _store.load(data_dir)


def save_presets(data_dir: Path, file: LiveLayoutPresetsFile) -> None:
    _store.save(data_dir, file)


def list_presets_sync(data_dir: Path) -> list[LiveLayoutPresetListRow]:
    return _store.list_sync(data_dir)


def create_preset_sync(
    data_dir: Path, *, req: LiveLayoutPresetWriteRequest, id: str, now_ms: int
) -> LiveLayoutPreset:
    return _store.create_sync(data_dir, req=req, id=id, now_ms=now_ms)


def update_preset_sync(
    data_dir: Path, *, id: str, req: LiveLayoutPresetWriteRequest, now_ms: int
) -> LiveLayoutPreset:
    return _store.update_sync(data_dir, id=id, req=req, now_ms=now_ms)


def delete_preset_sync(data_dir: Path, *, id: str) -> None:
    _store.delete_sync(data_dir, id=id)


async def create_preset(
    data_dir: Path, *, req: LiveLayoutPresetWriteRequest, id: str, now_ms: int
) -> LiveLayoutPreset:
    return await _store.create(data_dir, req=req, id=id, now_ms=now_ms)


async def update_preset(
    data_dir: Path, *, id: str, req: LiveLayoutPresetWriteRequest, now_ms: int
) -> LiveLayoutPreset:
    return await _store.update(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_preset(data_dir: Path, *, id: str) -> None:
    await _store.delete(data_dir, id=id)
