"""Heatmap persistence + async-safe mutations.

The Heatmap is an INDEPENDENT monitoring list, separate from the Watchlist
(ADR-0068). It mirrors the watchlist store's folder/entry CRUD but WITHOUT
hogaplay-capture semantics: no ``last_success_date`` / ``registered_at_kst_date``,
no ``bump_last_success`` / ``set_last_success``. Since ADR-0097 heatmap codes DO
feed the KIS REST 30s recorder as REST-only extras (never the WS subscription);
the store itself stays capture-field-free — coverage planning reads it via
``load_heatmap``.

Cloned from ``watchlist.py`` rather than generalized (ADR-0068 / grilling G2):
the watchlist store is entangled with the capture finalize hook + daily
scheduler, so cloning keeps this additive and zero-risk to that hot path. Only
the genuinely capture-agnostic, type-free helper ``_mint_folder_id`` is shared.

Own ``_lock`` — NOT the watchlist lock — so heatmap UI mutations never
serialize behind the capture finalize hook (ADR-0068 rule 1).
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
from pathlib import Path

from pydantic import ValidationError

from hoga.api._atomic_write import atomic_write_json
from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.api.watchlist import _mint_folder_id  # shared pure helper (ADR-0068 G2)

log = logging.getLogger(__name__)

# v2→v3 마이그레이션에서 folder_id=null(구 미분류) 종목을 수용하는 실폴더 (ADR-0111).
# 결정론적 id — load 는 디스크에 쓰지 않으므로(다음 mutation 이 저장) 랜덤 id 면
# 로드마다 id 가 바뀌어 프론트 접기상태(폴더 id 키)가 흔들린다. watchlist v3 의
# _DEFAULT_FOLDER_ID 와 같은 값이지만 별개 문서 스코프(문서 간 id 공유는 무해 — G5).
_UNCAT_FOLDER_ID = "f_00000000"
_UNCAT_FOLDER_NAME = "미분류"

# Own lock — serializes load → mutate → save across heatmap writers only.
# Deliberately NOT watchlist._lock: the heatmap must never block (or be blocked
# by) the capture finalize hook / daily scheduler (ADR-0068 rule 1).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "heatmap.json"


class UnsupportedHeatmapSchema(Exception):
    """An unrecognised FUTURE schema_version (>3). NOT a ValueError so
    load_document's corruption catch does not swallow it — an unknown future
    version must halt loudly, never be downgraded (ADR-0065)."""


def _migrate(raw: dict) -> dict:
    """Normalise any on-disk shape to a v3 dict, repairing (not wiping) drift.
    Mirrors watchlist._migrate (ADR-0065 governance applied independently).

    v3 (ADR-0111): folder_id is required. A folder-less entry (v1/v2 미분류,
    or a v3 entry whose folder id dangles) is rescued into the 미분류 REAL
    folder (_UNCAT_FOLDER_ID) — an ordinary folder thereafter (renamable,
    deletable, never auto-recreated). If that id already exists (heatmap.json
    seeded verbatim from a v3 watchlist carries f_00000000 '기본'), rescued
    entries merge into the existing folder instead of duplicating the id."""
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 3:
        raise UnsupportedHeatmapSchema(f"unsupported heatmap schema_version {version}")
    folders = [dict(f) for f in raw.get("folders", [])] if version >= 2 else []
    valid_ids = {f.get("id") for f in folders}
    entries: list[dict] = []
    rescued = False
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)
        e["order"] = e.get("order", i)
        if e.get("folder_id") not in valid_ids:
            e["folder_id"] = _UNCAT_FOLDER_ID
            # 기존 per-folder order 대역(0..k-1) 위로 올려 rescue 종목이 수용 폴더의
            # 기존 멤버 뒤에 서게 한다 — _reindex 가 최종 0..N-1 로 압축.
            e["order"] += len(raw.get("entries", []))
            rescued = True
        entries.append(e)
    if rescued and _UNCAT_FOLDER_ID not in valid_ids:
        folders.append({"id": _UNCAT_FOLDER_ID, "name": _UNCAT_FOLDER_NAME,
                        "order": len(folders)})
    return {"schema_version": 3, "folders": folders, "entries": entries}


def _reindex(doc: HeatmapDocument) -> HeatmapDocument:
    """Reassign entry.order to 0..N-1 within each folder group,
    folders[].order to 0..N-1. Flat list order preserved. Idempotent."""
    groups: dict[str, list[int]] = {}
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


def load_document(data_dir: Path) -> HeatmapDocument:
    """Read heatmap.json as a v2 HeatmapDocument. Missing → empty doc.
    Genuine corruption → backup + empty (never crash/wipe on read, ADR-0065);
    an unrecognised future version raises UnsupportedHeatmapSchema (loud)."""
    p = _path(data_dir)
    if not p.exists():
        return HeatmapDocument()
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
        doc = HeatmapDocument.model_validate(_migrate(raw))
    except (json.JSONDecodeError, ValidationError, TypeError, AttributeError, ValueError) as e:
        stamp = dt.datetime.now().strftime("%Y%m%dT%H%M%S")
        backup = p.with_name(f"heatmap.json.corrupt-{stamp}")
        try:
            p.rename(backup)
        except OSError:
            log.exception("could not back up corrupt heatmap.json")
        log.warning("heatmap.json was corrupt (%s); backed up to %s", e, backup)
        return HeatmapDocument()
    return _reindex(doc)


def save_document(data_dir: Path, doc: HeatmapDocument) -> None:
    """Atomic write of the WHOLE v2 document. The only write path."""
    atomic_write_json(_path(data_dir), _reindex(doc).model_dump())


def load_heatmap(data_dir: Path) -> list[HeatmapEntry]:
    """Read-only convenience for callers that only need the entry list."""
    return load_document(data_dir).entries


def seed_from_watchlist_if_absent(data_dir: Path) -> None:
    """One-time seed (ADR-0068 rule 3 / grilling G6).

    Copy the watchlist's folders + entries into heatmap.json (capture fields
    stripped) the FIRST time heatmap.json is absent AND the watchlist is
    non-empty. Idempotent: a present heatmap.json (even empty) skips. An empty
    watchlist also skips — so a fresh machine retries on the next boot rather
    than creating a permanently-empty heatmap that never re-seeds. Reads the
    watchlist READ-ONLY (never writes it), so the watchlist is never at risk.

    folder_id is copied verbatim (folder ids are document-scoped, no
    cross-store registry, so the same id in both files is safe — grilling G5).

    v3 (ADR-0070): the watchlist now stores membership on folder.member_codes
    (entries are slim), and a Code may be in several folders. The heatmap is a
    single-folder board, so each Code is seeded into the FIRST folder it appears
    in (display order) — a one-time snapshot, thereafter independent.
    """
    if _path(data_dir).exists():
        return
    # Local import: avoids any chance of an import cycle at module load.
    from hoga.api import watchlist as _watchlist
    wl = _watchlist.load_document(data_dir)
    if not wl.entries:
        return  # nothing to seed yet; retry next boot
    from hoga.api.watchlist_projection import first_membership_positions, ordered_folders

    folders = [WatchlistFolder(id=f.id, name=f.name, order=f.order) for f in ordered_folders(wl)]
    placement = first_membership_positions(wl)
    name_by_code = {e.code: e.name for e in wl.entries}
    entries = [
        HeatmapEntry(code=code, name=name_by_code.get(code, code),
                     folder_id=fid, order=order)
        for code, (fid, order) in placement.items()
    ]
    save_document(data_dir, HeatmapDocument(folders=folders, entries=entries))
    log.info("seeded heatmap.json from watchlist: %d folders, %d entries",
             len(folders), len(entries))


class NotInHeatmapError(Exception):
    """Raised by remove_entry when the Code is absent."""


class HeatmapSetMismatchError(Exception):
    """Raised by reorder_folders / reorder_entries when the authoritative
    ordered set the client sent does not match the current set. Routes map
    this to 409 (stale/inconsistent client list), not 404."""


class FolderNotFoundError(Exception):
    """Raised when a folder_id is absent from the Heatmap."""


async def add_entry_to_folder(
    data_dir: Path,
    *,
    code: str,
    name: str,
    folder_id: str,
) -> HeatmapEntry:
    """Add code to the Heatmap placed in folder_id — the ONLY add command
    (v3, ADR-0111: every entry needs a real folder, so a folder-less add_entry
    no longer exists).

    If the code already exists, this moves the existing entry to folder_id
    instead of failing.
    """
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        existing = next((e for e in doc.entries if e.code == code), None)
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        if existing is None:
            entry = HeatmapEntry(code=code, name=name, folder_id=folder_id, order=base)
            save_document(data_dir, doc.model_copy(update={"entries": [*doc.entries, entry]}))
            return entry
        if existing.folder_id == folder_id:
            entry = existing.model_copy(update={"name": name})
            save_document(
                data_dir,
                doc.model_copy(update={
                    "entries": [entry if e.code == code else e for e in doc.entries],
                }),
            )
            return entry
        entry = existing.model_copy(update={"name": name, "folder_id": folder_id, "order": base})
        save_document(
            data_dir,
            doc.model_copy(update={
                "entries": [entry if e.code == code else e for e in doc.entries],
            }),
        )
        return entry


async def remove_entry(data_dir: Path, *, code: str) -> None:
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInHeatmapError(code)
        save_document(data_dir, doc.model_copy(
            update={"entries": [e for e in doc.entries if e.code != code]}))


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
        # (model_copy skips validation; a blank/over-length name would otherwise
        # be persisted unchecked and quarantine the whole doc on next load).
        new = [WatchlistFolder(id=f.id, name=name.strip(), order=f.order)
               if f.id == folder_id else f
               for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def delete_folder(data_dir: Path, *, folder_id: str) -> None:
    """Delete the folder AND its member entries (v3, ADR-0111 — destructive,
    watchlist delete_folder semantics; there is no 미분류 to reparent into).
    The UI confirms before calling when the folder has members; this function
    itself is the committed delete. Callers must resync storage targets — the
    entry SET may shrink (ADR-0097)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f for f in doc.folders if f.id != folder_id]
        new_entries = [e for e in doc.entries if e.folder_id != folder_id]
        save_document(data_dir, doc.model_copy(
            update={"folders": new_folders, "entries": new_entries}))


async def reorder_folders(data_dir: Path, *, ordered_ids: list[str]) -> None:
    """Set folders[].order to match ordered_ids. Unknown / missing ids are
    rejected so client and server can't drift."""
    async with _lock:
        doc = load_document(data_dir)
        current = {f.id for f in doc.folders}
        if len(ordered_ids) != len(current) or set(ordered_ids) != current:
            raise HeatmapSetMismatchError(f"ordered_ids {ordered_ids} != {current}")
        by_id = {f.id: f for f in doc.folders}
        new = [by_id[fid].model_copy(update={"order": i})
               for i, fid in enumerate(ordered_ids)]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def move_entries(data_dir: Path, *, codes: list[str], folder_id: str) -> None:
    """Move codes into folder_id (a real folder — v3 has no null group),
    appended after the target's current members, preserving caller order. A
    code already in folder_id is a no-op; absent codes are ignored. _reindex
    compacts order to 0..N-1."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        by_code = {e.code: e for e in doc.entries}
        moving = [c for c in codes if c in by_code and by_code[c].folder_id != folder_id]
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        pos = {c: i for i, c in enumerate(moving)}
        new = [
            e.model_copy(update={"folder_id": folder_id, "order": base + pos[e.code]})
            if e.code in pos else e
            for e in doc.entries
        ]
        save_document(data_dir, doc.model_copy(update={"entries": new}))


async def reorder_entries(data_dir: Path, *, folder_id: str,
                          ordered_codes: list[str]) -> None:
    """Authoritative reorder within one folder: ordered_codes must be exactly
    the codes currently in folder_id. Server reassigns order = position."""
    async with _lock:
        doc = load_document(data_dir)
        in_folder = {e.code for e in doc.entries if e.folder_id == folder_id}
        if len(ordered_codes) != len(in_folder) or set(ordered_codes) != in_folder:
            raise HeatmapSetMismatchError(
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
