"""SavedScreener persistence + async-safe CRUD. Mirrors watchlist.py:
file=SSOT, module _lock, lock-free reads, atomic writes (OSError propagates).
See docs/superpowers/specs/2026-05-31-saved-screener-design.md + ADR-0019."""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from hoga.api.models import (
    SavedScreener,
    SavedScreenersFile,
    ScreenerSaveWriteRequest,
)
from hoga.api.versioned_json_file import load_versioned_json_file
from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)
_lock = asyncio.Lock()
_CURRENT_VERSION = 1


def _path(data_dir: Path, policy: str = "legacy_v1") -> Path:
    return data_dir / "screener" / ("saves.v2.json" if policy != "legacy_v1" else "saves.json")


def _log_quarantine(reason: str, path: Path, error: OSError | None) -> None:
    if error is not None:
        log.exception("could not back up corrupt saves.json")
        return
    log.warning("screener saves.json unusable (%s); backed up to %s", reason, path)


def _load_file(data_dir: Path, policy: str = "legacy_v1") -> SavedScreenersFile:
    """Pure read: missing→empty; future version / corrupt→quarantine+empty.
    Migrates older versions in-memory (v1 has no predecessor yet)."""
    return load_versioned_json_file(
        _path(data_dir, policy),
        model=SavedScreenersFile,
        current_version=2 if policy != "legacy_v1" else _CURRENT_VERSION,
        empty_factory=SavedScreenersFile,
        on_quarantine=_log_quarantine,
    )


def load_saves(data_dir: Path) -> SavedScreenersFile:
    old, new = _load_file(data_dir), _load_file(data_dir, "separate_bases_v2")
    return SavedScreenersFile(saves=[*old.saves, *new.saves])


def save_saves(data_dir: Path, file: SavedScreenersFile, policy: str = "legacy_v1") -> None:
    """Atomic write. OSError PROPAGATES (file=SSOT → swallowing = silent loss)."""
    value = file.model_dump(mode="json")
    if policy != "legacy_v1":
        value["schema_version"] = 2
    atomic_write_json(_path(data_dir, policy), value)


class ScreenerSaveNotFoundError(Exception):
    """Raised when a SavedScreener id is absent."""


async def list_saves(data_dir: Path) -> list[SavedScreener]:
    return load_saves(data_dir).saves


async def get_save(data_dir: Path, *, id: str) -> SavedScreener:
    for s in load_saves(data_dir).saves:
        if s.id == id:
            return s
    raise ScreenerSaveNotFoundError(id)


async def create_save(
    data_dir: Path, *, req: ScreenerSaveWriteRequest, id: str, now_ms: int
) -> SavedScreener:
    async with _lock:
        f = _load_file(data_dir, req.calculation_policy)
        s = SavedScreener(
            id=id, created_at_ms=now_ms, updated_at_ms=now_ms, **req.model_dump()
        )
        f.saves.append(s)
        save_saves(data_dir, f, req.calculation_policy)
        return s


async def update_save(
    data_dir: Path, *, id: str, req: ScreenerSaveWriteRequest, now_ms: int
) -> SavedScreener:
    async with _lock:
        found = await get_save(data_dir, id=id)
        if found.calculation_policy != req.calculation_policy:
            raise ValueError("기존 조건의 계산 기준은 덮어쓸 수 없습니다. 새 기준으로 복사하세요")
        f = _load_file(data_dir, req.calculation_policy)
        for idx, old in enumerate(f.saves):
            if old.id == id:
                new = SavedScreener(
                    id=id,
                    created_at_ms=old.created_at_ms,
                    updated_at_ms=now_ms,
                    **req.model_dump(),
                )
                f.saves[idx] = new
                save_saves(data_dir, f, req.calculation_policy)
                return new
        raise ScreenerSaveNotFoundError(id)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        found = await get_save(data_dir, id=id)
        f = _load_file(data_dir, found.calculation_policy)
        if not any(s.id == id for s in f.saves):
            raise ScreenerSaveNotFoundError(id)
        f.saves = [s for s in f.saves if s.id != id]
        save_saves(data_dir, f, found.calculation_policy)
