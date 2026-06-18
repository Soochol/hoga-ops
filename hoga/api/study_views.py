from __future__ import annotations

import asyncio
from contextlib import suppress
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)
from hoga.api.study_snapshot_contract import prepare_restorable_snapshot
from hoga.api.versioned_json_file import load_versioned_json_file

_CURRENT_VERSION = 1
_lock = asyncio.Lock()


class StudyViewNotFoundError(Exception):
    pass


class StudyViewSnapshotMissingError(Exception):
    pass


class StudyViewSnapshotInvalidError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "study_views"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def _snapshot_path(data_dir: Path, id: str) -> Path:
    return _root(data_dir) / "snapshots" / f"{id}.json"


def _staged_snapshot_path(data_dir: Path, id: str) -> Path:
    return _root(data_dir) / "snapshots" / f"{id}.json.staged"


def load_saves(data_dir: Path) -> StudyViewsFile:
    return load_versioned_json_file(
        _manifest_path(data_dir),
        model=StudyViewsFile,
        current_version=_CURRENT_VERSION,
        empty_factory=StudyViewsFile,
    )


def save_saves(data_dir: Path, file: StudyViewsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def load_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot:
    p = _snapshot_path(data_dir, id)
    if not p.exists():
        raise StudyViewNotFoundError(id)
    try:
        return ParquetStudySnapshot.model_validate_json(p.read_text(encoding="utf-8"))
    except ValidationError as e:
        raise StudyViewSnapshotInvalidError(id) from e


def load_restorable_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot:
    get_save_sync(data_dir, id=id)
    p = _snapshot_path(data_dir, id)
    if not p.exists():
        raise StudyViewSnapshotMissingError(id)
    try:
        snapshot = ParquetStudySnapshot.model_validate_json(p.read_text(encoding="utf-8"))
    except ValidationError as e:
        raise StudyViewSnapshotInvalidError(id) from e
    return prepare_restorable_snapshot(data_dir, snapshot)


def _view_from_req(
    data_dir: Path,
    *,
    req: ParquetStudyViewWriteRequest,
    id: str,
    created_at_ms: int,
    updated_at_ms: int,
    snapshot_size_bytes: int | None = None,
) -> ParquetStudyView:
    snap_path = _snapshot_path(data_dir, id)
    if snapshot_size_bytes is not None:
        size = snapshot_size_bytes
    elif snap_path.exists():
        size = snap_path.stat().st_size
    else:
        size = 0
    return ParquetStudyView(
        id=id,
        name=req.name,
        code=req.code,
        label=req.label,
        timeframe=req.timeframe,
        snapshot_from_ms=req.snapshot_from_ms,
        snapshot_to_ms=req.snapshot_to_ms,
        viewport=req.viewport,
        indicator_state=req.indicator_state,
        memo=req.memo,
        tags=req.tags,
        provenance=req.provenance,
        snapshot_schema_version=req.snapshot.schema_version,
        snapshot_path=f"study_views/snapshots/{id}.json",
        snapshot_size_bytes=size,
        created_at_ms=created_at_ms,
        updated_at_ms=updated_at_ms,
    )


def list_saves_sync(data_dir: Path) -> list[ParquetStudyView]:
    return load_saves(data_dir).saves


def get_save_sync(data_dir: Path, *, id: str) -> ParquetStudyView:
    for save in load_saves(data_dir).saves:
        if save.id == id:
            return save
    raise StudyViewNotFoundError(id)


def create_save_sync(
    data_dir: Path, *, req: ParquetStudyViewWriteRequest, id: str, now_ms: int
) -> ParquetStudyView:
    snapshot_path = _snapshot_path(data_dir, id)
    enriched_snapshot = prepare_restorable_snapshot(data_dir, req.snapshot)
    req = req.model_copy(update={"snapshot": enriched_snapshot})
    atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))
    file = load_saves(data_dir)
    save = _view_from_req(data_dir, req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
    file.saves.append(save)
    file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
    try:
        save_saves(data_dir, file)
    except OSError:
        with suppress(OSError):
            snapshot_path.unlink(missing_ok=True)
        raise
    return save


def update_save_sync(
    data_dir: Path, *, id: str, req: ParquetStudyViewWriteRequest, now_ms: int
) -> ParquetStudyView:
    file = load_saves(data_dir)
    for idx, old in enumerate(file.saves):
        if old.id == id:
            old_file = file.model_copy(deep=True)
            staged_path = _staged_snapshot_path(data_dir, id)
            enriched_snapshot = prepare_restorable_snapshot(data_dir, req.snapshot)
            req = req.model_copy(update={"snapshot": enriched_snapshot})
            atomic_write_json(staged_path, req.snapshot.model_dump(mode="json"))
            new = _view_from_req(
                data_dir,
                req=req,
                id=id,
                created_at_ms=old.created_at_ms,
                updated_at_ms=now_ms,
                snapshot_size_bytes=staged_path.stat().st_size,
            )
            file.saves[idx] = new
            file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
            try:
                save_saves(data_dir, file)
            except OSError:
                with suppress(OSError):
                    staged_path.unlink(missing_ok=True)
                raise
            try:
                staged_path.replace(_snapshot_path(data_dir, id))
            except OSError:
                save_saves(data_dir, old_file)
                with suppress(OSError):
                    staged_path.unlink(missing_ok=True)
                raise
            return new
    raise StudyViewNotFoundError(id)


def delete_save_sync(data_dir: Path, *, id: str) -> None:
    file = load_saves(data_dir)
    if not any(s.id == id for s in file.saves):
        raise StudyViewNotFoundError(id)
    old_file = file.model_copy(deep=True)
    file.saves = [s for s in file.saves if s.id != id]
    save_saves(data_dir, file)
    try:
        _snapshot_path(data_dir, id).unlink()
    except FileNotFoundError:
        pass
    except OSError:
        save_saves(data_dir, old_file)
        raise


async def create_save(
    data_dir: Path, *, req: ParquetStudyViewWriteRequest, id: str, now_ms: int
) -> ParquetStudyView:
    async with _lock:
        return create_save_sync(data_dir, req=req, id=id, now_ms=now_ms)


async def update_save(
    data_dir: Path, *, id: str, req: ParquetStudyViewWriteRequest, now_ms: int
) -> ParquetStudyView:
    async with _lock:
        return update_save_sync(data_dir, id=id, req=req, now_ms=now_ms)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        delete_save_sync(data_dir, id=id)
