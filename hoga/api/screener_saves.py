"""SavedScreener persistence + async-safe CRUD. Mirrors watchlist.py:
file=SSOT, module _lock, lock-free reads, atomic writes (OSError propagates).
See docs/superpowers/specs/2026-05-31-saved-screener-design.md + ADR-0019."""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import (
    SavedScreener,
    SavedScreenersFile,
    ScreenerSaveWriteRequest,
)

log = logging.getLogger(__name__)
_lock = asyncio.Lock()
_CURRENT_VERSION = 1


def _path(data_dir: Path) -> Path:
    return data_dir / "screener" / "saves.json"


def _quarantine(p: Path, reason: str) -> SavedScreenersFile:
    stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = p.with_name(f"saves.json.corrupt-{stamp}-{reason}")
    try:
        p.rename(backup)
    except OSError:
        log.exception("could not back up corrupt saves.json")
    log.warning("screener saves.json unusable (%s); backed up to %s", reason, backup)
    return SavedScreenersFile()


def load_saves(data_dir: Path) -> SavedScreenersFile:
    """Pure read: missing→empty; future version / corrupt→quarantine+empty.
    Migrates older versions in-memory (v1 has no predecessor yet)."""
    p = _path(data_dir)
    if not p.exists():
        return SavedScreenersFile()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return _quarantine(p, "badjson")
    if not isinstance(raw, dict):
        # Valid JSON but not an object ([], 5, "x") → raw.get below would
        # AttributeError and escape quarantine. Treat as corrupt.
        return _quarantine(p, "badshape")
    if raw.get("schema_version", 0) > _CURRENT_VERSION:
        return _quarantine(p, "future-version")
    try:
        return SavedScreenersFile.model_validate(raw)
    except ValidationError:
        return _quarantine(p, "schema")


def save_saves(data_dir: Path, file: SavedScreenersFile) -> None:
    """Atomic write. OSError PROPAGATES (file=SSOT → swallowing = silent loss)."""
    atomic_write_json(_path(data_dir), file.model_dump(mode="json"))


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
        f = load_saves(data_dir)
        s = SavedScreener(
            id=id, created_at_ms=now_ms, updated_at_ms=now_ms, **req.model_dump()
        )
        f.saves.append(s)
        save_saves(data_dir, f)
        return s


async def update_save(
    data_dir: Path, *, id: str, req: ScreenerSaveWriteRequest, now_ms: int
) -> SavedScreener:
    async with _lock:
        f = load_saves(data_dir)
        for idx, old in enumerate(f.saves):
            if old.id == id:
                new = SavedScreener(
                    id=id,
                    created_at_ms=old.created_at_ms,
                    updated_at_ms=now_ms,
                    **req.model_dump(),
                )
                f.saves[idx] = new
                save_saves(data_dir, f)
                return new
        raise ScreenerSaveNotFoundError(id)


async def delete_save(data_dir: Path, *, id: str) -> None:
    async with _lock:
        f = load_saves(data_dir)
        if not any(s.id == id for s in f.saves):
            raise ScreenerSaveNotFoundError(id)
        f.saves = [s for s in f.saves if s.id != id]
        save_saves(data_dir, f)
