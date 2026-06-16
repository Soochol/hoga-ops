from __future__ import annotations

import asyncio
import datetime as dt
import json
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    ParquetStudySnapshot,
    ParquetStudyView,
    ParquetStudyViewWriteRequest,
    StudyViewsFile,
)

_CURRENT_VERSION = 1
_lock = asyncio.Lock()


class StudyViewNotFoundError(Exception):
    pass


def _root(data_dir: Path) -> Path:
    return data_dir / "study_views"


def _manifest_path(data_dir: Path) -> Path:
    return _root(data_dir) / "saves.json"


def _snapshot_path(data_dir: Path, id: str) -> Path:
    return _root(data_dir) / "snapshots" / f"{id}.json"


def _staged_snapshot_path(data_dir: Path, id: str) -> Path:
    return _root(data_dir) / "snapshots" / f"{id}.json.staged"


def _quarantine(p: Path, reason: str) -> StudyViewsFile:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = p.with_name(f"saves.json.corrupt-{stamp}-{reason}")
    try:
        p.rename(backup)
    except OSError:
        pass
    return StudyViewsFile()


def load_saves(data_dir: Path) -> StudyViewsFile:
    p = _manifest_path(data_dir)
    if not p.exists():
        return StudyViewsFile()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return _quarantine(p, "badjson")
    if not isinstance(raw, dict):
        return _quarantine(p, "badshape")
    schema_version = raw.get("schema_version", 0)
    if isinstance(schema_version, int) and schema_version > _CURRENT_VERSION:
        return _quarantine(p, "future-version")
    try:
        return StudyViewsFile.model_validate(raw)
    except ValidationError:
        return _quarantine(p, "schema")


def save_saves(data_dir: Path, file: StudyViewsFile) -> None:
    atomic_write_json(_manifest_path(data_dir), file.model_dump(mode="json"))


def load_snapshot(data_dir: Path, *, id: str) -> ParquetStudySnapshot:
    p = _snapshot_path(data_dir, id)
    if not p.exists():
        raise StudyViewNotFoundError(id)
    return ParquetStudySnapshot.model_validate_json(p.read_text(encoding="utf-8"))


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


def create_save_sync(data_dir: Path, *, req: ParquetStudyViewWriteRequest, id: str, now_ms: int) -> ParquetStudyView:
    snapshot_path = _snapshot_path(data_dir, id)
    atomic_write_json(snapshot_path, req.snapshot.model_dump(mode="json"))
    file = load_saves(data_dir)
    save = _view_from_req(data_dir, req=req, id=id, created_at_ms=now_ms, updated_at_ms=now_ms)
    file.saves.append(save)
    file.saves.sort(key=lambda s: s.updated_at_ms, reverse=True)
    try:
        save_saves(data_dir, file)
    except OSError:
        try:
            snapshot_path.unlink(missing_ok=True)
        except OSError:
            pass
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
                try:
                    staged_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            try:
                staged_path.replace(_snapshot_path(data_dir, id))
            except OSError:
                save_saves(data_dir, old_file)
                try:
                    staged_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise
            return new
    raise StudyViewNotFoundError(id)


def delete_save_sync(data_dir: Path, *, id: str) -> None:
    file = load_saves(data_dir)
    if not any(s.id == id for s in file.saves):
        raise StudyViewNotFoundError(id)
    file.saves = [s for s in file.saves if s.id != id]
    save_saves(data_dir, file)
    try:
        _snapshot_path(data_dir, id).unlink()
    except FileNotFoundError:
        pass


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
