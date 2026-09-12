from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path

from hoga.api.models import (
    StudyViewGroup,
    StudyViewGroupWriteRequest,
    StudyViewListRow,
    StudyViewMetadataUpdateRequest,
    StudyViewMoveRequest,
    StudyViewReference,
    StudyViewReferenceWriteRequest,
    StudyViewsFile,
)
from hoga.util.atomic_write import atomic_write_json

_CURRENT_VERSION = 2
_lock = asyncio.Lock()


class StudyViewNotFoundError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "study_views"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def load_saves(data_dir: Path) -> StudyViewsFile:
    path = _manifest_path(data_dir)
    if not path.exists():
        return StudyViewsFile()
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict) or type(raw.get("schema_version")) is not int:
        raise ValueError("저장뷰 파일 형식을 확인할 수 없습니다")
    if raw["schema_version"] == 1:
        if not isinstance(raw.get("saves"), list):
            raise ValueError("기존 저장뷰 목록 형식이 올바르지 않습니다")
        for row in raw["saves"]:
            StudyViewReference.model_validate({**row, "group_id": "legacy"})
        # User-authorized one-time reset of the old Code-grouped list only.
        file = StudyViewsFile()
        save_saves(data_dir, file)
        return file
    if raw["schema_version"] != _CURRENT_VERSION:
        raise ValueError("지원하지 않는 저장뷰 파일 버전입니다")
    return StudyViewsFile.model_validate(raw)


class StudyViewGroupError(ValueError):
    pass


def _group(file: StudyViewsFile, group_id: str) -> StudyViewGroup:
    for group in file.groups:
        if group.id == group_id:
            return group
    raise StudyViewGroupError("그룹이 삭제되었습니다 · 그룹을 다시 선택하세요")


def _new_group(file: StudyViewsFile, name: str) -> StudyViewGroup:
    name = StudyViewGroupWriteRequest(name=name).name
    if any(group.name.casefold() == name.casefold() for group in file.groups):
        raise StudyViewGroupError("이미 있는 그룹 이름입니다 · 기존 그룹에서 선택하세요")
    group = StudyViewGroup(id=uuid.uuid4().hex, name=name)
    file.groups.append(group)
    return group


def _save_group(file: StudyViewsFile, req: StudyViewReferenceWriteRequest) -> str:
    if bool(req.group_id) == bool(req.new_group_name):
        raise StudyViewGroupError("저장 그룹을 선택하거나 새 그룹 이름을 입력하세요")
    return (_new_group(file, req.new_group_name) if req.new_group_name else _group(file, req.group_id or "")).id


def save_saves(data_dir: Path, file: StudyViewsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def _reference_from_req(
    *,
    req: StudyViewReferenceWriteRequest,
    id: str,
    group_id: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> StudyViewReference:
    return StudyViewReference(
        id=id,
        group_id=group_id,
        name=req.name,
        code=req.code,
        label=req.label,
        timeframe=req.timeframe,
        range=req.range,
        viewport=req.viewport,
        memo=req.memo,
        tags=req.tags,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def list_saves_sync(data_dir: Path) -> list[StudyViewListRow]:
    return load_saves(data_dir).saves


def get_save_sync(data_dir: Path, *, id: str) -> StudyViewListRow:
    for save in load_saves(data_dir).saves:
        if save.id == id:
            return save
    raise StudyViewNotFoundError(id)


def create_save_sync(
    data_dir: Path, *, req: StudyViewReferenceWriteRequest, id: str, now_ms: int
) -> StudyViewReference:
    file = load_saves(data_dir)
    save = _reference_from_req(
        req=req, id=id, group_id=_save_group(file, req), created_at_ms=now_ms, updated_at_ms=now_ms
    )
    file.saves.append(save)
    file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
    save_saves(data_dir, file)
    return save


def update_save_sync(
    data_dir: Path, *, id: str, req: StudyViewReferenceWriteRequest, now_ms: int
) -> StudyViewReference:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            save = _reference_from_req(
                req=req,
                id=id,
                group_id=_save_group(file, req),
                created_at_ms=old.created_at_ms,
                updated_at_ms=now_ms,
            )
            file.saves[idx] = save
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            save_saves(data_dir, file)
            return save
    raise StudyViewNotFoundError(id)


def update_save_metadata_sync(
    data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int
) -> StudyViewListRow:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            updates: dict[str, object] = {"updated_at_ms": now_ms}
            if req.name is not None:
                updates["name"] = req.name
            if req.memo is not None:
                updates["memo"] = req.memo
            new = old.model_copy(update=updates)
            file.saves[idx] = new
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            save_saves(data_dir, file)
            return new
    raise StudyViewNotFoundError(id)


def delete_save_sync(data_dir: Path, *, id: str) -> None:
    file = load_saves(data_dir)
    if not any(s.id == id for s in file.saves):
        raise StudyViewNotFoundError(id)
    file.saves = [s for s in file.saves if s.id != id]
    save_saves(data_dir, file)


async def create_save(
    data_dir: Path, *, req: StudyViewReferenceWriteRequest, id: str, now_ms: int
) -> StudyViewReference:
    async with _lock:
        return create_save_sync(data_dir, req=req, id=id, now_ms=now_ms)


async def update_save(
    data_dir: Path, *, id: str, req: StudyViewReferenceWriteRequest, now_ms: int
) -> StudyViewReference:
    async with _lock:
        return update_save_sync(data_dir, id=id, req=req, now_ms=now_ms)


async def update_save_metadata(
    data_dir: Path, *, id: str, req: StudyViewMetadataUpdateRequest, now_ms: int
) -> StudyViewListRow:
    async with _lock:
        return update_save_metadata_sync(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        delete_save_sync(data_dir, id=id)


async def create_group(data_dir: Path, req: StudyViewGroupWriteRequest) -> StudyViewGroup:
    async with _lock:
        file = load_saves(data_dir)
        group = _new_group(file, req.name)
        save_saves(data_dir, file)
        return group


async def rename_group(data_dir: Path, group_id: str, req: StudyViewGroupWriteRequest) -> StudyViewGroup:
    async with _lock:
        file = load_saves(data_dir)
        group = _group(file, group_id)
        if any(g.id != group_id and g.name.casefold() == req.name.casefold() for g in file.groups):
            raise StudyViewGroupError("이미 있는 그룹 이름입니다")
        group.name = req.name
        save_saves(data_dir, file)
        return group


async def delete_group(data_dir: Path, group_id: str) -> None:
    async with _lock:
        file = load_saves(data_dir)
        _group(file, group_id)
        file.groups = [g for g in file.groups if g.id != group_id]
        file.saves = [s for s in file.saves if s.group_id != group_id]
        save_saves(data_dir, file)


async def move_saves(data_dir: Path, req: StudyViewMoveRequest) -> StudyViewsFile:
    async with _lock:
        file = load_saves(data_dir)
        _group(file, req.group_id)
        ids = set(req.ids)
        if ids - {s.id for s in file.saves}:
            raise StudyViewGroupError("삭제된 저장뷰가 있습니다 · 목록을 다시 확인하세요")
        for save in file.saves:
            if save.id in ids:
                save.group_id = req.group_id
        save_saves(data_dir, file)
        return file
