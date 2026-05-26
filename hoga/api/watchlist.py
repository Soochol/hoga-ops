"""Watchlist persistence + async-safe mutations.

See CONTEXT.md ("Watchlist", "WatchlistEntry") and spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md.

ADR-0034 invariant: the Daily Scheduler / Catch-up Run import this
module, but this module does NOT import captures.py. The reverse
dependency (captures.py importing bump_last_success) goes through a
local-import to avoid cycles.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from dataclasses import dataclass
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import WatchlistEntry

log = logging.getLogger(__name__)

# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


@dataclass(frozen=True)
class Watchlist:
    """In-memory snapshot. Order preserved = display order."""
    entries: list[WatchlistEntry]


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


def load_watchlist(data_dir: Path) -> Watchlist:
    """Read watchlist.json. Missing file → empty. Corrupt file → backup +
    empty + warning log."""
    p = _path(data_dir)
    if not p.exists():
        return Watchlist(entries=[])
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        entries = [WatchlistEntry.model_validate(e) for e in raw.get("entries", [])]
        return Watchlist(entries=entries)
    except Exception as e:  # noqa: BLE001 — any parse/validation failure
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"watchlist.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt watchlist.json")
        log.warning("watchlist.json was corrupt (%s); backed up to %s",
                    e, backup)
        return Watchlist(entries=[])


def save_watchlist(data_dir: Path, *, entries: list[WatchlistEntry]) -> None:
    """Atomic write."""
    payload = {
        "version": 1,
        "entries": [e.model_dump() for e in entries],
    }
    atomic_write_json(_path(data_dir), payload)
