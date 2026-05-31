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
from hoga.api.models import SavedScreenersFile

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
    if raw.get("schema_version", 0) > _CURRENT_VERSION:
        return _quarantine(p, "future-version")
    try:
        return SavedScreenersFile.model_validate(raw)
    except ValidationError:
        return _quarantine(p, "schema")


def save_saves(data_dir: Path, file: SavedScreenersFile) -> None:
    """Atomic write. OSError PROPAGATES (file=SSOT → swallowing = silent loss)."""
    atomic_write_json(_path(data_dir), file.model_dump(mode="json"))
