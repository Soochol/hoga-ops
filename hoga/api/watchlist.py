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
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import WatchlistEntry

log = logging.getLogger(__name__)

# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


def load_watchlist(data_dir: Path) -> list[WatchlistEntry]:
    """Read watchlist.json. Missing file → empty. Corrupt file → backup +
    empty + warning log. Order preserved = display order."""
    p = _path(data_dir)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        entries = [WatchlistEntry.model_validate(e) for e in raw.get("entries", [])]
        return entries
    except Exception as e:  # noqa: BLE001 — any parse/validation failure
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"watchlist.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt watchlist.json")
        log.warning("watchlist.json was corrupt (%s); backed up to %s",
                    e, backup)
        return []


def save_watchlist(data_dir: Path, *, entries: list[WatchlistEntry]) -> None:
    """Atomic write."""
    payload = {
        "version": 1,
        "entries": [e.model_dump() for e in entries],
    }
    atomic_write_json(_path(data_dir), payload)


class AlreadyInWatchlistError(Exception):
    """Raised by add_entry when the Code is already present."""


class NotInWatchlistError(Exception):
    """Raised by remove_entry when the Code is absent."""


async def add_entry(
    data_dir: Path,
    *,
    code: str,
    name: str,
    today_kst_date: str,
) -> WatchlistEntry:
    async with _lock:
        entries = load_watchlist(data_dir)
        if any(e.code == code for e in entries):
            raise AlreadyInWatchlistError(code)
        entry = WatchlistEntry(
            code=code,
            name=name,
            registered_at_kst_date=today_kst_date,
            last_success_date=None,
        )
        save_watchlist(data_dir, entries=[*entries, entry])
        return entry


async def remove_entry(data_dir: Path, *, code: str) -> None:
    async with _lock:
        entries = load_watchlist(data_dir)
        if not any(e.code == code for e in entries):
            raise NotInWatchlistError(code)
        save_watchlist(
            data_dir,
            entries=[e for e in entries if e.code != code],
        )


async def bump_last_success(
    data_dir: Path,
    *,
    code: str,
    date: str,
) -> None:
    """Advance ``last_success_date`` for ``code`` if ``date`` is newer.

    Silent no-op when ``code`` is not in the Watchlist (capture was ad-hoc)
    or when ``date`` is not newer than the existing marker (out-of-order
    completions cannot regress).
    """
    async with _lock:
        entries = load_watchlist(data_dir)
        new_entries: list[WatchlistEntry] = []
        changed = False
        for e in entries:
            if e.code == code and (
                e.last_success_date is None or date > e.last_success_date
            ):
                new_entries.append(e.model_copy(update={"last_success_date": date}))
                changed = True
            else:
                new_entries.append(e)
        if changed:
            save_watchlist(data_dir, entries=new_entries)
