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
import secrets
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder

log = logging.getLogger(__name__)

# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


class UnsupportedWatchlistSchema(Exception):
    """Raised by _migrate for an unrecognised FUTURE schema_version (>2).
    Deliberately NOT a ValueError, so load_document's corruption catch (which
    includes ValueError for malformed on-disk shapes) does not swallow it: an
    unrecognised future version must halt loudly, never be downgraded (ADR-0065).
    """


def _migrate(raw: dict) -> dict:
    """Normalise any on-disk shape to a v2 dict, repairing (not wiping) drift.

    - v1 (`{version:1, entries:[...]}`) or field-less legacy → seed
      `folder_id=null`, `order` by index, `folders=[]`.
    - Dangling `folder_id` (references a missing folder) → repaired to null
      rather than rejected (watchlist = irreplaceable user data, ADR-0065).
    Genuine corruption (bad JSON / field-pattern violations) is NOT handled
    here — it surfaces as ValidationError to load_document's backup path.
    """
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 2:
        # ADR-0065 rule 1: an unrecognised FUTURE version must RAISE, not be
        # silently downgraded — never clobber data a newer build wrote. A
        # dedicated (non-ValueError) type so load_document's corruption catch
        # doesn't swallow it; it propagates loudly.
        raise UnsupportedWatchlistSchema(f"unsupported watchlist schema_version {version}")
    folders = raw.get("folders", []) if version >= 2 else []
    valid_ids = {f.get("id") for f in folders}
    entries: list[dict] = []
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)
        fid = e.get("folder_id")
        e["folder_id"] = fid if fid in valid_ids else None
        e["order"] = e.get("order", i)
        entries.append(e)
    return {"schema_version": 2, "folders": folders, "entries": entries}


def _reindex(doc: WatchlistDocument) -> WatchlistDocument:
    """Reassign entry.order to 0..N-1 within each folder group (incl. null),
    ranking by current order then flat position; folders[].order to 0..N-1.
    Flat list order is preserved. Idempotent."""
    groups: dict[str | None, list[int]] = {}
    for idx, e in enumerate(doc.entries):
        groups.setdefault(e.folder_id, []).append(idx)
    order_for: dict[int, int] = {}
    for idxs in groups.values():
        for rank, i in enumerate(sorted(idxs, key=lambda i: (doc.entries[i].order, i))):
            order_for[i] = rank
    new_entries = [e.model_copy(update={"order": order_for[i]})
                   for i, e in enumerate(doc.entries)]
    fsorted = sorted(range(len(doc.folders)),
                     key=lambda i: (doc.folders[i].order, i))
    fo = {orig: rank for rank, orig in enumerate(fsorted)}
    new_folders = [f.model_copy(update={"order": fo[i]})
                   for i, f in enumerate(doc.folders)]
    return doc.model_copy(update={"folders": new_folders, "entries": new_entries})


def load_document(data_dir: Path) -> WatchlistDocument:
    """Read watchlist.json as a v2 WatchlistDocument. Missing → empty doc.
    Forward-migrates v1 in place (never quarantines — ADR-0065). Genuine
    corruption (invalid JSON / schema-violating entries) → backup + empty,
    matching the prior behaviour; OSError propagates."""
    p = _path(data_dir)
    if not p.exists():
        return WatchlistDocument()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        doc = WatchlistDocument.model_validate(_migrate(raw))
    except (json.JSONDecodeError, ValidationError, TypeError, AttributeError, ValueError) as e:
        # Corruption = unparseable JSON, schema-violating fields, OR a malformed
        # shape that trips _migrate's structural ops (non-dict root / entries /
        # folders → TypeError / AttributeError / ValueError, e.g. dict("str")).
        # Back up + return empty instead of crashing on a read (ADR-0065: never
        # crash or wipe silently on the read path). The schema_version>2 guard
        # raises UnsupportedWatchlistSchema (a non-ValueError) which is NOT caught
        # here, so an unrecognised future version still halts loudly.
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"watchlist.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt watchlist.json")
        log.warning("watchlist.json was corrupt (%s); backed up to %s", e, backup)
        return WatchlistDocument()
    # _reindex runs on a VALIDATED doc, outside the corruption catch, so a bug
    # there propagates instead of being silently masked as corruption + wiped.
    return _reindex(doc)


def save_document(data_dir: Path, doc: WatchlistDocument) -> None:
    """Atomic write of the WHOLE v2 document. The only write path."""
    atomic_write_json(_path(data_dir), _reindex(doc).model_dump())


def load_watchlist(data_dir: Path) -> list[WatchlistEntry]:
    """Read-only convenience for callers that only need the entry list
    (Daily Scheduler, catch-up routes, live poller). Writers MUST use
    load_document/save_document to preserve folders."""
    return load_document(data_dir).entries


class AlreadyInWatchlistError(Exception):
    """Raised by add_entry when the Code is already present."""


class NotInWatchlistError(Exception):
    """Raised by remove_entry when the Code is absent."""


class WatchlistSetMismatchError(Exception):
    """Raised by reorder_folders / reorder_entries when the authoritative
    ordered set the client sent does not match the current set (extra, missing,
    or duplicate ids/codes). Distinct from the "absent id/code" errors above:
    routes map this to 409 (a stale/inconsistent client list), not 404."""


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
        doc = load_document(data_dir)
        if any(e.code == code for e in doc.entries):
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
            folder_id=None,
            # Seed beyond any existing per-group order so the new Code sorts
            # LAST in 미분류; _reindex (which ranks by `order` first) then
            # compresses it to the final slot. Seeding 0 would tie the first
            # existing entry and mis-rank the new one second. len(entries) is a
            # safe upper bound: per-group orders are 0..k-1 for k entries.
            order=len(doc.entries),
        )
        save_document(data_dir, doc.model_copy(update={"entries": [*doc.entries, entry]}))
        return entry


async def remove_entry(data_dir: Path, *, code: str) -> None:
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInWatchlistError(code)
        save_document(data_dir, doc.model_copy(
            update={"entries": [e for e in doc.entries if e.code != code]}))


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
        doc = load_document(data_dir)
        new_entries: list[WatchlistEntry] = []
        changed = False
        for e in doc.entries:
            if e.code == code and (
                e.last_success_date is None or date > e.last_success_date
            ):
                new_entries.append(e.model_copy(update={"last_success_date": date}))
                changed = True
            else:
                new_entries.append(e)
        if changed:
            save_document(data_dir, doc.model_copy(update={"entries": new_entries}))


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
        doc = load_document(data_dir)
        new_entries: list[WatchlistEntry] = []
        changed = False
        for e in doc.entries:
            if e.code == code and e.last_success_date != date:
                new_entries.append(e.model_copy(update={"last_success_date": date}))
                changed = True
            else:
                new_entries.append(e)
        if changed:
            save_document(data_dir, doc.model_copy(update={"entries": new_entries}))


class FolderNotFoundError(Exception):
    """Raised when a folder_id is absent from the Watchlist."""


def _mint_folder_id() -> str:
    return "f_" + secrets.token_hex(4)


async def create_folder(data_dir: Path, *, name: str) -> WatchlistFolder:
    async with _lock:
        doc = load_document(data_dir)
        folder = WatchlistFolder(id=_mint_folder_id(), name=name.strip(),
                                 order=len(doc.folders))
        save_document(data_dir, doc.model_copy(update={"folders": [*doc.folders, folder]}))
        return folder


async def rename_folder(data_dir: Path, *, folder_id: str, name: str) -> None:
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        # Reconstruct through WatchlistFolder so the stripped name is VALIDATED
        # the same way create_folder validates it. model_copy(update=...) skips
        # validation, so a whitespace-only name (strips to "" < min_length=1) or
        # an over-length name (>max_length=40 after strip) would otherwise be
        # persisted unchecked and then trip model_validate on the NEXT load —
        # quarantining the whole watchlist (ADR-0065: irreplaceable user data).
        new = [WatchlistFolder(id=f.id, name=name.strip(), order=f.order)
               if f.id == folder_id else f
               for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def delete_folder(data_dir: Path, *, folder_id: str) -> None:
    """Delete the folder and reparent its members to 미분류 (folder_id=null)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f for f in doc.folders if f.id != folder_id]
        new_entries = [e.model_copy(update={"folder_id": None}) if e.folder_id == folder_id else e
                       for e in doc.entries]
        save_document(data_dir, doc.model_copy(
            update={"folders": new_folders, "entries": new_entries}))


async def reorder_folders(data_dir: Path, *, ordered_ids: list[str]) -> None:
    """Set folders[].order to match ordered_ids. Unknown / missing ids are
    rejected so the client and server can't drift."""
    async with _lock:
        doc = load_document(data_dir)
        current = {f.id for f in doc.folders}
        if len(ordered_ids) != len(current) or set(ordered_ids) != current:
            raise WatchlistSetMismatchError(f"ordered_ids {ordered_ids} != {current}")
        # Emit folders in ordered_ids order: _reindex (B2) preserves the flat
        # list order and only normalizes the `order` field, so the physical
        # list — not just the field — must be reordered for the new sequence
        # to survive a load_document round-trip.
        by_id = {f.id: f for f in doc.folders}
        new = [by_id[fid].model_copy(update={"order": i})
               for i, fid in enumerate(ordered_ids)]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def move_entries(data_dir: Path, *, codes: list[str], folder_id: str | None) -> None:
    """Move the given codes into folder_id (null = 미분류), appended after the
    target folder's current members, preserving caller order. A code already in
    folder_id is a **no-op** (it is NOT bumped to the bottom); absent codes are
    ignored. _reindex compacts order to 0..N-1."""
    async with _lock:
        doc = load_document(data_dir)
        if folder_id is not None and not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        by_code = {e.code: e for e in doc.entries}
        # Only codes that actually change folder move; a code already in the
        # target folder stays in place (moving onto your own folder = no-op).
        moving = [c for c in codes if c in by_code and by_code[c].folder_id != folder_id]
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        pos = {c: i for i, c in enumerate(moving)}
        new = [
            e.model_copy(update={"folder_id": folder_id, "order": base + pos[e.code]})
            if e.code in pos else e
            for e in doc.entries
        ]
        save_document(data_dir, doc.model_copy(update={"entries": new}))


async def reorder_entries(data_dir: Path, *, folder_id: str | None,
                          ordered_codes: list[str]) -> None:
    """Authoritative reorder within one folder: ordered_codes must be exactly
    the codes currently in folder_id. Server reassigns order = position."""
    async with _lock:
        doc = load_document(data_dir)
        in_folder = {e.code for e in doc.entries if e.folder_id == folder_id}
        if len(ordered_codes) != len(in_folder) or set(ordered_codes) != in_folder:
            raise WatchlistSetMismatchError(
                f"reorder set {ordered_codes} != folder {folder_id} members {in_folder}")
        rank = {c: i for i, c in enumerate(ordered_codes)}
        new = [e.model_copy(update={"order": rank[e.code]}) if e.folder_id == folder_id else e
               for e in doc.entries]
        save_document(data_dir, doc.model_copy(update={"entries": new}))


async def remove_entries(data_dir: Path, *, codes: list[str]) -> None:
    """Bulk remove. Absent codes are ignored (idempotent bulk delete)."""
    async with _lock:
        doc = load_document(data_dir)
        keep = [e for e in doc.entries if e.code not in set(codes)]
        save_document(data_dir, doc.model_copy(update={"entries": keep}))
