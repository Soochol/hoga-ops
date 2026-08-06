"""Heatmap persistence + async-safe mutations.

The Heatmap is an INDEPENDENT monitoring list, separate from the Watchlist
(ADR-0068). It mirrors the watchlist store's folder/entry CRUD, and since
ADR-0142 it is ALSO a daily hogaplay capture target: the 17:00 KST run enqueues
watchlist ∪ heatmap, and this module keeps the matching ``bump_last_success`` /
``set_last_success``.

The markers live in a code-keyed ``capture_markers`` side table, NOT on
``HeatmapEntry`` — entry identity here is ``(folder_id, code)``, so a per-entry
marker would fork into one value per group while the capture it describes is
keyed ``(code, date)``. There is no ``registered_at_kst_date`` counterpart: the
watchlist kept that solely as the catch-up backfill floor, and catch-up is
same-day only since ADR-0142.

Heatmap codes also feed the Kiwoom WS storage set (ADR-0116/0118) — coverage
planning reads them via ``load_heatmap``. (The ADR-0097 KIS REST 30s recorder
this docstring used to cite was removed with the rest of REST orderbook capture
in 2026-07-17.)

Cloned from ``watchlist.py`` rather than generalized (ADR-0068 / grilling G2):
the watchlist store is entangled with the capture finalize hook + daily
scheduler, so cloning keeps this additive and zero-risk to that hot path. Only
the genuinely capture-agnostic, type-free helper ``_mint_folder_id`` is shared.

Own ``_lock`` — NOT the watchlist lock. ADR-0068 rule 1 was about UI mutations
never serializing behind the watchlist's finalize hook; ADR-0142 gives the
heatmap a finalize hook of its own, and keeping the locks separate means the
two stores' hooks still cannot block each other.

**Entry identity is ``(folder_id, code)``** — one Code may be registered in
several groups at once. Commands that target a single registration therefore
take the folder as well (``remove_entry(folder_id=...)``,
``move_entries(from_folder_id=...)``). Callers that want the *set of codes*
(REST-30s targets, quote fetches) must de-duplicate — ``load_heatmap`` returns
one row per registration, not per code.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import re
from pathlib import Path

from pydantic import ValidationError

from hoga.api.models import HeatmapDocument, HeatmapEntry, WatchlistFolder
from hoga.api.params import CODE_PATTERN
from hoga.api.watchlist import _mint_folder_id  # shared pure helper (ADR-0068 G2)
from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)

# v2→v3 마이그레이션에서 folder_id=null(구 미분류) 종목을 수용하는 실폴더 (ADR-0112).
# 결정론적 id — load 는 디스크에 쓰지 않으므로(다음 mutation 이 저장) 랜덤 id 면
# 로드마다 id 가 바뀌어 프론트 접기상태(폴더 id 키)가 흔들린다. watchlist v3 의
# _DEFAULT_FOLDER_ID 와 같은 값이지만 별개 문서 스코프(문서 간 id 공유는 무해 — G5).
_UNCAT_FOLDER_ID = "f_00000000"
_UNCAT_FOLDER_NAME = "미분류"

# capture_markers 방어 파싱용(ADR-0142). params.CODE_PATTERN 을 그대로 쓰되 여기서
# 컴파일해 둔다 — _clean_markers 는 load 마다 271행을 훑는 자리다.
_CODE_RE = re.compile(CODE_PATTERN)
_DATE_RE = re.compile(r"^\d{8}$")

# Own lock — serializes load → mutate → save across heatmap writers only.
# Deliberately NOT watchlist._lock: the heatmap must never block (or be blocked
# by) the capture finalize hook / daily scheduler (ADR-0068 rule 1).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "heatmap.json"


class UnsupportedHeatmapSchema(Exception):
    """An unrecognised FUTURE schema_version (>4). NOT a ValueError so
    load_document's corruption catch does not swallow it — an unknown future
    version must halt loudly, never be downgraded (ADR-0065)."""


def _clean_markers(raw: dict) -> dict[str, str]:
    """Keep only well-formed ``code → YYYYMMDD`` capture markers (ADR-0142).

    Malformed rows are DROPPED, never raised on. The markers are a cache of
    disk truth (``latest_complete_date`` recomputes them), whereas the folders
    and entries around them are irreplaceable user data. Letting one bad marker
    reach ``model_validate`` would fail the whole document and send 40 groups /
    271 registrations to the corrupt-backup path — trading unrecoverable data
    for recoverable data, which is exactly backwards (ADR-0065 rule 1).
    """
    markers = raw.get("capture_markers")
    if not isinstance(markers, dict):
        return {}
    out: dict[str, str] = {}
    for code, date in markers.items():
        if not isinstance(code, str) or not isinstance(date, str):
            continue
        if not _CODE_RE.fullmatch(code) or not _DATE_RE.fullmatch(date):
            continue
        out[code] = date
    if len(out) != len(markers):
        log.warning("heatmap.capture_markers: dropped %d malformed row(s)",
                    len(markers) - len(out))
    return out


def _migrate(raw: dict) -> dict:
    """Normalise any on-disk shape to a v4 dict, repairing (not wiping) drift.
    Mirrors watchlist._migrate (ADR-0065 governance applied independently).

    v4 (ADR-0142): ``capture_markers`` (code → last COMPLETE date). Older files
    have none — an absent marker already means "never captured", so v3→v4 is a
    pure field addition with no backfill. Seeding it from disk here would put
    271 stat() sweeps on the read path; the daily run's finalize hook and the
    same-day catch-up reconcile fill it in as captures land.

    v3 (ADR-0112): folder_id is required. A folder-less entry (v1/v2 미분류,
    or a v3 entry whose folder id dangles) is rescued into the 미분류 REAL
    folder (_UNCAT_FOLDER_ID) — an ordinary folder thereafter (renamable,
    deletable, never auto-recreated). If that id already exists (heatmap.json
    seeded verbatim from a v3 watchlist carries f_00000000 '기본'), rescued
    entries merge into the existing folder instead of duplicating the id.

    A Code may repeat ACROSS folders (multi-group membership) but not within
    one: two dangling rows for the same code both land in 미분류 and would
    collide, so same-folder repeats are dropped (first wins) rather than left
    to fail HeatmapDocument validation — which would quarantine the whole file
    as "corrupt" and lose every other group."""
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 4:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise UnsupportedHeatmapSchema(f"unsupported heatmap schema_version {version}")
    folders = [dict(f) for f in raw.get("folders", [])] if version >= 2 else []  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
    valid_ids = {f.get("id") for f in folders}
    entries: list[dict] = []
    seen: set[tuple[str, str]] = set()
    rescued = False
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)  # noqa: PLW2901 — 방어적 복사·정규화 후 재대입
        e["order"] = e.get("order", i)
        if e.get("folder_id") not in valid_ids:
            e["folder_id"] = _UNCAT_FOLDER_ID
            # 기존 per-folder order 대역(0..k-1) 위로 올려 rescue 종목이 수용 폴더의
            # 기존 멤버 뒤에 서게 한다 — _reindex 가 최종 0..N-1 로 압축.
            e["order"] += len(raw.get("entries", []))
            rescued = True
        key = (str(e.get("folder_id")), str(e.get("code")))
        if key in seen:
            continue
        seen.add(key)
        entries.append(e)
    if rescued and _UNCAT_FOLDER_ID not in valid_ids:
        folders.append({"id": _UNCAT_FOLDER_ID, "name": _UNCAT_FOLDER_NAME,
                        "order": len(folders)})
    return {"schema_version": 4, "folders": folders, "entries": entries,
            "capture_markers": _clean_markers(raw)}


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
    """Read heatmap.json as a v3 HeatmapDocument. Missing → empty doc.
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


def _prune_orphan_markers(doc: HeatmapDocument) -> HeatmapDocument:
    """Drop capture markers whose Code is no longer registered in any group.

    Write path ONLY — the read path must preserve drift (ADR-0065). Mirrors
    watchlist._prune_orphans, which is what makes marker cleanup automatic:
    every removal command (remove_entry / remove_entries / delete_folder)
    touches only ``entries``, and the marker follows on save. Pure, idempotent.
    """
    registered = {e.code for e in doc.entries}
    kept = {c: d for c, d in doc.capture_markers.items() if c in registered}
    if len(kept) == len(doc.capture_markers):
        return doc
    return doc.model_copy(update={"capture_markers": kept})


def save_document(data_dir: Path, doc: HeatmapDocument) -> None:
    """Atomic write of the WHOLE v4 document. The only write path — so it is
    the single seam that drops markers for de-registered Codes."""
    atomic_write_json(_path(data_dir), _prune_orphan_markers(_reindex(doc)).model_dump())


def load_capture_markers(data_dir: Path) -> dict[str, str]:
    """Code → latest COMPLETE capture date (YYYYMMDD). Absent = never captured."""
    return load_document(data_dir).capture_markers


async def bump_last_success(data_dir: Path, *, code: str, date: str) -> None:
    """Advance ``code``'s marker if ``date`` is newer (ADR-0142).

    Silent no-op when the Code is not on the heatmap (the capture was for the
    watchlist or ad-hoc) or when ``date`` is not newer — out-of-order
    completions must not regress the marker. Advance-only, mirroring
    watchlist.bump_last_success; the finalize hook calls both.

    There is deliberately NO ``set_last_success`` counterpart. The watchlist
    needs one because its catch-up reconciles the marker against
    ``latest_complete_date`` and must be able to REGRESS it. The heatmap has no
    catch-up (ADR-0142: same-day only), so its marker means "last capture that
    succeeded" rather than "what is on disk right now" — a retention prune must
    not rewrite it backwards. Disk residency is the inventory's question.
    """
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            return
        current = doc.capture_markers.get(code)
        if current is not None and date <= current:
            return
        save_document(data_dir, doc.model_copy(
            update={"capture_markers": {**doc.capture_markers, code: date}}))


def load_heatmap(data_dir: Path) -> list[HeatmapEntry]:
    """Read-only convenience for callers that only need the entry list.

    One row per REGISTRATION: a Code registered in three groups appears three
    times. Callers deriving a code SET (REST-30s targets, quote fetches) must
    de-duplicate."""
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
    from hoga.api import watchlist as _watchlist  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
    wl = _watchlist.load_document(data_dir)
    if not wl.entries:
        return  # nothing to seed yet; retry next boot
    from hoga.api.watchlist_projection import (  # noqa: PLC0415 — 지연 import(순환 절단·heavy 모듈·monkeypatch 시임)
        first_membership_positions,
        ordered_folders,
    )

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
    """Register code in folder_id — the ONLY add command (v3, ADR-0112: every
    entry needs a real folder, so a folder-less add_entry no longer exists).

    Multi-group membership: a code already registered in ANOTHER group is added
    here too (both registrations stand) instead of being moved. Re-adding it to
    the SAME group is idempotent — it refreshes the display name and keeps the
    existing position, so a double-click never duplicates a row or shuffles the
    group. "Move it instead" is the separate, explicit ``move_entries``.

    A Code entering the heatmap for the FIRST time (no registration in any
    group) gets its capture marker seeded from disk (ADR-0142), matching
    watchlist.add_member. Without the seed a Code that already has captures on
    disk would render as "미수집" until the next daily run overwrote it.
    """
    # Local import: disk_state -> heatmap would cycle if at module top.
    from hoga.api.disk_state import latest_complete_date  # noqa: PLC0415 — 지연 import(순환/heavy)
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        here = next(
            (e for e in doc.entries if e.code == code and e.folder_id == folder_id), None)
        if here is not None:
            entry = here.model_copy(update={"name": name})
            save_document(
                data_dir,
                doc.model_copy(update={
                    "entries": [entry if e is here else e for e in doc.entries],
                }),
            )
            return entry
        markers = doc.capture_markers
        if not any(e.code == code for e in doc.entries):
            latest = latest_complete_date(data_dir, code)
            if latest is not None:
                markers = {**markers, code: latest}
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        entry = HeatmapEntry(code=code, name=name, folder_id=folder_id, order=base)
        save_document(data_dir, doc.model_copy(update={
            "entries": [*doc.entries, entry], "capture_markers": markers}))
        return entry


async def remove_entry(data_dir: Path, *, code: str, folder_id: str | None = None) -> None:
    """Unregister code. ``folder_id`` given → drop only THAT registration (the
    row the user right-clicked), leaving the code's other groups alone; omitted
    → drop it from every group ("히트맵에서 완전히 제거"). Absent → NotInHeatmapError,
    so a stale UI still gets a 404 rather than a silent success."""
    async with _lock:
        doc = load_document(data_dir)
        def targeted(e: HeatmapEntry) -> bool:
            return e.code == code and (folder_id is None or e.folder_id == folder_id)
        if not any(targeted(e) for e in doc.entries):
            raise NotInHeatmapError(code)
        save_document(data_dir, doc.model_copy(
            update={"entries": [e for e in doc.entries if not targeted(e)]}))


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
    """Delete the folder AND its member entries (v3, ADR-0112 — destructive,
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


async def move_entries(data_dir: Path, *, codes: list[str], from_folder_id: str,
                       folder_id: str) -> None:
    """Move codes OUT OF from_folder_id INTO folder_id (both real folders — v3
    has no null group), appended after the target's current members, preserving
    caller order. Codes absent from the source group are ignored; from == to is
    a no-op. _reindex compacts order to 0..N-1.

    Multi-group membership makes the source explicit: without it "move 005930"
    would silently pick one of its registrations. A code already registered in
    the TARGET group collapses — the source registration is dropped rather than
    duplicated (a folder holds each code at most once)."""
    async with _lock:
        doc = load_document(data_dir)
        for fid in (from_folder_id, folder_id):
            if not any(f.id == fid for f in doc.folders):
                raise FolderNotFoundError(fid)
        if from_folder_id == folder_id:
            return
        source = {e.code for e in doc.entries if e.folder_id == from_folder_id}
        already = {e.code for e in doc.entries if e.folder_id == folder_id}
        moving = [c for c in codes if c in source]
        pos = {c: i for i, c in enumerate(c for c in moving if c not in already)}
        collapsing = {c for c in moving if c in already}
        base = max((e.order for e in doc.entries if e.folder_id == folder_id), default=-1) + 1
        new = [
            e.model_copy(update={"folder_id": folder_id, "order": base + pos[e.code]})
            if e.folder_id == from_folder_id and e.code in pos else e
            for e in doc.entries
            if not (e.folder_id == from_folder_id and e.code in collapsing)
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
    """Bulk remove — every registration of each code, in ALL groups (there is
    no folder-scoped bulk surface). Absent codes are ignored (idempotent)."""
    async with _lock:
        doc = load_document(data_dir)
        keep = [e for e in doc.entries if e.code not in set(codes)]
        save_document(data_dir, doc.model_copy(update={"entries": keep}))
