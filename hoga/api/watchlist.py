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

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import WatchlistEntry

log = logging.getLogger(__name__)

# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


def load_watchlist(data_dir: Path) -> list[WatchlistEntry]:
    """Read watchlist.json. Missing file → empty. **Corrupt** file (invalid
    JSON or schema-violating entries) → backup + empty + warning log.
    Order preserved = display order.

    Narrow exception handling: only :class:`json.JSONDecodeError` and
    :class:`pydantic.ValidationError` are treated as "corruption" worth
    auto-backing-up. Anything else (OSError on read, programming bugs,
    etc.) propagates — auto-rename on a transient read failure would
    silently wipe user data.
    """
    p = _path(data_dir)
    if not p.exists():
        return []
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        entries = [WatchlistEntry.model_validate(e) for e in raw.get("entries", [])]
        return entries
    except (json.JSONDecodeError, ValidationError) as e:
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
    # Local import: disk_state -> watchlist would cycle if at module top.
    from hoga.api.disk_state import latest_complete_date
    async with _lock:
        entries = load_watchlist(data_dir)
        if any(e.code == code for e in entries):
            raise AlreadyInWatchlistError(code)
        # Seed from disk: if the Code already has captured data, the marker
        # reflects the latest existing Stock-Date instead of starting null.
        # See CONTEXT.md ("last_success_date") — the marker tracks "latest
        # COMPLETE on disk", not "latest done since registration".
        entry = WatchlistEntry(
            code=code,
            name=name,
            registered_at_kst_date=today_kst_date,
            last_success_date=latest_complete_date(data_dir, code),
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


async def reorder_entries(
    data_dir: Path,
    *,
    codes: list[str],
) -> list[WatchlistEntry]:
    """Rewrite watchlist order to match ``codes``.

    Tolerant of a stale ``codes`` list (a concurrent add/remove means the
    caller's view may differ from disk): codes not currently present are
    ignored; entries not mentioned in ``codes`` are appended in their
    existing relative order. Shares ``_lock`` with add/remove/bump so a
    concurrent mutation cannot interleave a half-applied state. No-op write:
    if the resulting order equals the current order, the file is not touched.

    Only the order changes — ``last_success_date`` / ``registered_at_kst_date``
    are preserved by re-using the existing entry objects.
    """
    async with _lock:
        entries = load_watchlist(data_dir)
        by_code = {e.code: e for e in entries}
        seen: set[str] = set()
        ordered: list[WatchlistEntry] = []
        for c in codes:
            e = by_code.get(c)
            if e is not None and c not in seen:
                ordered.append(e)
                seen.add(c)
        for e in entries:
            if e.code not in seen:
                ordered.append(e)
        if [e.code for e in ordered] != [e.code for e in entries]:
            save_watchlist(data_dir, entries=ordered)
        return ordered


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

    Race-safe advance only. For reconcile-from-disk (which may need to
    *regress* a stale marker when disk truth is older), use
    :func:`set_last_success`.
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


async def set_last_success(
    data_dir: Path,
    *,
    code: str,
    date: str | None,
) -> None:
    """Force ``last_success_date`` to ``date`` exactly (either direction).

    Used by the catch-up reconciler when the authoritative on-disk
    ``latest_complete_date`` disagrees with the cached marker — including
    the case where disk truth is *older* (e.g. a previous bump treated an
    ``abort_reason=stagnation_abort`` finalize as success and advanced the
    marker past the actual latest COMPLETE).

    Race-safety: shares ``_lock`` with :func:`bump_last_success` and
    :func:`add_entry`, so concurrent finalize-side advance and reconcile
    cannot interleave a half-applied state. The semantic difference from
    ``bump_last_success`` is intent (forced sync to disk truth), not lock
    discipline.

    Silent no-op when ``code`` is not in the Watchlist.
    """
    async with _lock:
        entries = load_watchlist(data_dir)
        new_entries: list[WatchlistEntry] = []
        changed = False
        for e in entries:
            if e.code == code and e.last_success_date != date:
                new_entries.append(e.model_copy(update={"last_success_date": date}))
                changed = True
            else:
                new_entries.append(e)
        if changed:
            save_watchlist(data_dir, entries=new_entries)
