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


# 마이그레이션 보존 폴더의 결정적 id — random mint 를 피해 v2 파일을 매 load 마다
# 같은 id 로 접는다(미persist 상태에서 collapse-state/localStorage thrash 방지).
_DEFAULT_FOLDER_ID = "f_00000000"
_DEFAULT_FOLDER_NAME = "기본"


def _slim(e: dict) -> dict:
    """Wire/legacy entry dict → v3 slim store entry dict (백필 마커만)."""
    return {"code": e["code"], "name": e["name"],
            "registered_at_kst_date": e["registered_at_kst_date"],
            "last_success_date": e.get("last_success_date")}


def _migrate(raw: dict) -> dict:
    """어떤 on-disk 모양이든 v3 dict 로 정규화(데이터 보존, ADR-0065/0070).

    - v3: 방어적 통과(member_codes 보장, entry slim).
    - v1/v2: folder_id/order 를 폴더별 member_codes 로 접고, 어느 폴더에도 없던
      (folder_id=null) 종목은 신규 '기본' 폴더로 보존(안 옮기면 0폴더=유실).
    - schema_version>3: UnsupportedWatchlistSchema(loud halt, ADR-0065 rule 1).
    Genuine corruption (bad JSON / field-pattern violations) is NOT handled
    here — it surfaces as ValidationError to load_document's backup path.
    """
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 3:
        raise UnsupportedWatchlistSchema(f"unsupported watchlist schema_version {version}")
    if version >= 3:
        return {
            "schema_version": 3,
            "folders": [{"id": f["id"], "name": f["name"], "order": f.get("order", i),
                         "member_codes": list(f.get("member_codes", [])),
                         "capture_enabled": bool(f.get("capture_enabled", True))}
                        for i, f in enumerate(raw.get("folders", []))],
            "entries": [_slim(e) for e in raw.get("entries", [])],
        }
    # v1/legacy/v2 → v2-shaped (folder_id, order) 행 먼저
    folders_v2 = raw.get("folders", []) if version >= 2 else []
    valid_ids = {f.get("id") for f in folders_v2}
    v2_entries: list[dict] = []
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)
        fid = e.get("folder_id")
        e["folder_id"] = fid if fid in valid_ids else None
        e["order"] = e.get("order", i)
        v2_entries.append(e)
    # v2 → v3: 폴더별 member_codes(order순), null → '기본'
    by_fid: dict[str | None, list[dict]] = {}
    for e in v2_entries:
        by_fid.setdefault(e["folder_id"], []).append(e)

    def codes_in(fid: str | None) -> list[str]:
        return [e["code"] for e in sorted(by_fid.get(fid, []), key=lambda r: r["order"])]

    folders_v3 = [{"id": f["id"], "name": f["name"], "order": f.get("order", i),
                   "member_codes": codes_in(f["id"]), "capture_enabled": True}
                  for i, f in enumerate(folders_v2)]
    nulls = codes_in(None)
    if nulls:
        folders_v3.append({"id": _DEFAULT_FOLDER_ID, "name": _DEFAULT_FOLDER_NAME,
                           "order": len(folders_v3), "member_codes": nulls,
                           "capture_enabled": True})
    return {"schema_version": 3, "folders": folders_v3,
            "entries": [_slim(e) for e in v2_entries]}


def _reindex(doc: WatchlistDocument) -> WatchlistDocument:
    """folders[].order 를 0..N-1 로 정규화(현재 order 후 위치순; 물리 리스트 순서는
    보존 — reorder_folders 계약). 각 폴더 member_codes 중복 제거(첫 등장 유지).
    entry 는 손대지 않음(불변식은 write/마이그레이션 책임, ADR-0070). Idempotent."""
    fsorted = sorted(range(len(doc.folders)), key=lambda i: (doc.folders[i].order, i))
    fo = {orig: rank for rank, orig in enumerate(fsorted)}

    def dedupe(codes: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for c in codes:
            if c not in seen:
                seen.add(c)
                out.append(c)
        return out

    new_folders = [f.model_copy(update={"order": fo[i], "member_codes": dedupe(f.member_codes)})
                   for i, f in enumerate(doc.folders)]
    return doc.model_copy(update={"folders": new_folders})


def _prune_orphans(doc: WatchlistDocument) -> WatchlistDocument:
    """불변식 강제(ADR-0070): entry 존재 ⟺ 어떤 폴더 member_codes 에 있음. 어느 폴더에도
    없는 entry(orphan)를 제거한다. **write 경로(save_document)에서만** — read 경로(load)는
    drift를 보존·loud-log해야 한다(ADR-0065: read 에서 wipe 금지). 생성 절반(모든 member 에
    entry 존재)은 disk-seed 가 필요해 add_member(write 경로)가 책임진다. 순수·idempotent.

    이 한 곳이 prune 의 단일 소유자라, 멤버십을 줄이는 mutation(remove_member/remove_entry/
    remove_entries/delete_folder)은 member_codes 만 손대면 entry 정리는 자동이다.
    """
    members = {c for f in doc.folders for c in f.member_codes}
    kept = [e for e in doc.entries if e.code in members]
    if len(kept) == len(doc.entries):
        return doc
    return doc.model_copy(update={"entries": kept})


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
    """Atomic write of the WHOLE v3 document. The only write path — so it is the
    single seam that ENFORCES the invariant: _reindex normalizes folder order +
    dedupes member_codes, then _prune_orphans drops entries no longer in any
    folder. Mutations need only adjust member_codes; orphan cleanup is automatic."""
    atomic_write_json(_path(data_dir), _prune_orphans(_reindex(doc)).model_dump())


def load_watchlist(data_dir: Path) -> list[WatchlistEntry]:
    """Read-only convenience for callers that only need the entry list
    (Daily Scheduler, catch-up routes, live stream). Writers MUST use
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


async def add_member(
    data_dir: Path,
    *,
    code: str,
    name: str,
    today_kst_date: str,
    folder_id: str,
) -> WatchlistEntry:
    """code 를 folder_id 의 멤버로 추가(v3, ADR-0070). entry 가 없으면 생성하고
    last_success 를 디스크에서 시드(첫 Watchlist 진입). 이미 멤버면 멱등 no-op.
    폴더 없으면 FolderNotFoundError. 불변식 {e.code}==⋃member_codes 유지."""
    # Local import: disk_state -> watchlist would cycle if at module top.
    from hoga.api.disk_state import latest_complete_date
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        entries = list(doc.entries)
        entry = next((e for e in entries if e.code == code), None)
        if entry is None:
            # Seed from disk: the marker tracks "latest COMPLETE on disk"
            # (CONTEXT.md last_success_date), not "latest since registration".
            entry = WatchlistEntry(
                code=code, name=name, registered_at_kst_date=today_kst_date,
                last_success_date=latest_complete_date(data_dir, code),
            )
            entries.append(entry)
        new_folders = doc.folders
        if code not in folder.member_codes:  # idempotent: already a member → no-op
            new_folders = [f.model_copy(update={"member_codes": [*f.member_codes, code]})
                           if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": entries}))
        return entry


async def remove_member(data_dir: Path, *, code: str, folder_id: str) -> None:
    """code 를 folder_id 에서 제거(v3). 제거 후 어느 폴더에도 없으면 entry 삭제
    (Watchlist 탈락). 폴더 없으면 FolderNotFoundError. 멤버 아니면 멱등 no-op."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c != code]})
                       if f.id == folder_id else f for f in doc.folders]
        # member_codes 만 손댄다 — code 가 어느 폴더에도 없게 되면 save_document 가 orphan
        # entry 를 자동 prune 한다(불변식 단일 소유, ADR-0070).
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


async def remove_entry(data_dir: Path, *, code: str) -> None:
    """code 를 Watchlist 에서 완전 제거(모든 폴더 member_codes 에서 뺀다 → save 가 entry prune)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInWatchlistError(code)
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c != code]})
                       for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


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
                                 order=len(doc.folders), member_codes=[],
                                 capture_enabled=False)
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
        new = [WatchlistFolder(id=f.id, name=name.strip(), order=f.order,
                               member_codes=f.member_codes, capture_enabled=f.capture_enabled)
               if f.id == folder_id else f
               for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new}))


async def set_folder_capture_enabled(
    data_dir: Path,
    *,
    folder_id: str,
    capture_enabled: bool,
) -> WatchlistFolder:
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        updated = folder.model_copy(update={"capture_enabled": capture_enabled})
        folders = [updated if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": folders}))
        return updated


async def delete_folder(data_dir: Path, *, folder_id: str) -> None:
    """폴더 삭제(v3, ADR-0070). 그 폴더에만 있던 코드는 orphan → entry 삭제
    (Watchlist 탈락, 파괴적); 다른 폴더에도 있으면 entry 유지. UI 는 고아가 생기는
    삭제 전 사용자에게 확인한다(P6) — 이 함수 자체는 확정 삭제."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        # 폴더만 제거 — 그 폴더에만 있던 코드는 save_document 가 orphan 으로 prune 한다.
        new_folders = [f for f in doc.folders if f.id != folder_id]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


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


async def reorder_entries(data_dir: Path, *, folder_id: str,
                          ordered_codes: list[str]) -> None:
    """folder_id 의 member_codes 를 ordered_codes 로 재배열(v3). ordered_codes 는
    현재 멤버 집합과 정확히 일치해야 함(아니면 WatchlistSetMismatchError → 409)."""
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        if len(ordered_codes) != len(folder.member_codes) or set(ordered_codes) != set(folder.member_codes):
            raise WatchlistSetMismatchError(
                f"reorder set {ordered_codes} != folder {folder_id} members {folder.member_codes}")
        new_folders = [f.model_copy(update={"member_codes": list(ordered_codes)})
                       if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


async def remove_entries(data_dir: Path, *, codes: list[str]) -> None:
    """Bulk remove from the Watchlist (v3): drop the codes from every folder's
    member_codes and delete their entries. Absent codes ignored (idempotent)."""
    async with _lock:
        doc = load_document(data_dir)
        drop = set(codes)
        # member_codes 에서만 빼면 save_document 가 orphan entry 들을 prune 한다.
        new_folders = [f.model_copy(update={"member_codes": [c for c in f.member_codes if c not in drop]})
                       for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))
