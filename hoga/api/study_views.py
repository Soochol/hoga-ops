from __future__ import annotations

import asyncio
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    StudyViewListRow,
    StudyViewMetadataUpdateRequest,
    StudyViewReference,
    StudyViewReferenceWriteRequest,
    StudyViewsFile,
)
from hoga.api.versioned_json_file import load_versioned_json_file

_CURRENT_VERSION = 1
_lock = asyncio.Lock()


class StudyViewNotFoundError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "study_views"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def load_saves(data_dir: Path) -> StudyViewsFile:
    return load_versioned_json_file(
        _manifest_path(data_dir),
        model=StudyViewsFile,
        current_version=_CURRENT_VERSION,
        empty_factory=StudyViewsFile,
    )


def save_saves(data_dir: Path, file: StudyViewsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def _reference_from_req(
    *,
    req: StudyViewReferenceWriteRequest,
    id: str,
    created_at_ms: int,
    updated_at_ms: int,
) -> StudyViewReference:
    return StudyViewReference(
        id=id,
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
    save = _reference_from_req(req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
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
