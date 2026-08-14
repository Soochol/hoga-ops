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

from hoga.api.models import (
    WatchlistCodeItem,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistMemoItem,
)
from hoga.util.atomic_write import atomic_write_json

log = logging.getLogger(__name__)


# Module-scope lock — serializes load → mutate → save across all writers
# (API POST/DELETE and the _finalize_item hook).
_lock = asyncio.Lock()


def _path(data_dir: Path) -> Path:
    return data_dir / "watchlist.json"


class UnsupportedWatchlistSchema(Exception):
    """Raised by _migrate for an unrecognised FUTURE schema_version (>4).
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


def _code_items(codes: list[str]) -> list[dict]:
    """코드 리스트 → v4 items(전부 code kind). v3→v4 승격의 단위 연산."""
    return [{"kind": "code", "code": c} for c in codes]


def _without_codes(items: list, drop: set[str]) -> list:
    """items 에서 지정 코드의 code item 만 제거. **메모는 보존**된다.

    멤버십을 줄이는 mutation 전부(remove_member/remove_entry/remove_entries)가 이
    한 함수를 쓴다 — 메모 보존을 각 호출부가 따로 기억하지 않아도 되게.
    """
    return [i for i in items if not (isinstance(i, WatchlistCodeItem) and i.code in drop)]


def _migrate(raw: dict) -> dict:
    """어떤 on-disk 모양이든 v4 dict 로 정규화(데이터 보존, ADR-0065/0070).

    - v4: 방어적 통과(items 보장, entry slim).
    - v3: `member_codes` 를 items(code kind)로 승격.
    - v1/v2: folder_id/order 를 폴더별 코드 순서로 접고, 어느 폴더에도 없던
      (folder_id=null) 종목은 신규 '기본' 폴더로 보존(안 옮기면 0폴더=유실).
    - schema_version>4: UnsupportedWatchlistSchema(loud halt, ADR-0065 rule 1).

    Genuine corruption (bad JSON / field-pattern violations) is NOT handled
    here — it surfaces as ValidationError to load_document's backup path. v4
    items 의 **알 수 없는 kind 도 여기에 해당한다**: discriminated union 이
    ValidationError 를 내고 그 경로로 간다. 읽기 시점에 드롭하면 다음 save 가 그
    드롭을 영속시켜 read-path wipe 가 되므로(ADR-0065) 일부러 통과시킨다.
    """
    version = raw.get("schema_version", raw.get("version", 1))
    if version > 4:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        raise UnsupportedWatchlistSchema(f"unsupported watchlist schema_version {version}")
    if version >= 3:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
        # v3 는 member_codes, v4 는 items — 한쪽만 있다. 둘 다 없으면 빈 폴더.
        def items_of(f: dict) -> list[dict]:
            if "items" in f:
                return list(f["items"])
            return _code_items(list(f.get("member_codes", [])))

        return {
            "schema_version": 4,
            "folders": [{"id": f["id"], "name": f["name"], "order": f.get("order", i),
                         "items": items_of(f),
                         "capture_enabled": f["capture_enabled"] if "capture_enabled" in f else True}  # noqa: SIM401 — 분기가 기본값의 근거를 담고 있음
                        for i, f in enumerate(raw.get("folders", []))],
            "entries": [_slim(e) for e in raw.get("entries", [])],
        }
    # v1/legacy/v2 → v2-shaped (folder_id, order) 행 먼저
    folders_v2 = raw.get("folders", []) if version >= 2 else []  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
    valid_ids = {f.get("id") for f in folders_v2}
    v2_entries: list[dict] = []
    for i, e in enumerate(raw.get("entries", [])):
        e = dict(e)  # noqa: PLW2901 — 방어적 복사·정규화 후 재대입
        fid = e.get("folder_id")
        e["folder_id"] = fid if fid in valid_ids else None
        e["order"] = e.get("order", i)
        v2_entries.append(e)
    # v2 → v4: 폴더별 코드 순서(order순) → items, null → '기본'
    by_fid: dict[str | None, list[dict]] = {}
    for e in v2_entries:
        by_fid.setdefault(e["folder_id"], []).append(e)

    def codes_in(fid: str | None) -> list[str]:
        return [e["code"] for e in sorted(by_fid.get(fid, []), key=lambda r: r["order"])]

    folders_v4 = [{"id": f["id"], "name": f["name"], "order": f.get("order", i),
                   "items": _code_items(codes_in(f["id"])), "capture_enabled": True}
                  for i, f in enumerate(folders_v2)]
    nulls = codes_in(None)
    if nulls:
        folders_v4.append({"id": _DEFAULT_FOLDER_ID, "name": _DEFAULT_FOLDER_NAME,
                           "order": len(folders_v4), "items": _code_items(nulls),
                           "capture_enabled": True})
    return {"schema_version": 4, "folders": folders_v4,
            "entries": [_slim(e) for e in v2_entries]}


def _reindex(doc: WatchlistDocument) -> WatchlistDocument:
    """folders[].order 를 0..N-1 로 정규화(현재 order 후 위치순; 물리 리스트 순서는
    보존 — reorder_folders 계약). items 중복 제거(첫 등장 유지): 코드는 **폴더 안에서**,
    메모 id 는 **문서 전체에서**. entry 는 손대지 않음(불변식은 write/마이그레이션
    책임, ADR-0070). Idempotent.

    메모 id 를 전역 dedupe 하는 이유: PATCH/DELETE `/memos/{memo_id}` 가 folder_id
    없이 문서를 뒤지므로, 같은 id 가 두 폴더에 있으면 첫 번째만 고쳐지고 나머지는
    조용히 남는다. mint 가 secrets 라 충돌은 사실상 없지만, 손편집된 파일에서
    들어올 수 있어 여기서 막는다.
    """
    fsorted = sorted(range(len(doc.folders)), key=lambda i: (doc.folders[i].order, i))
    fo = {orig: rank for rank, orig in enumerate(fsorted)}
    seen_memo_ids: set[str] = set()

    def dedupe(items: list[WatchlistCodeItem | WatchlistMemoItem]) -> list:
        seen_codes: set[str] = set()
        out: list = []
        for it in items:
            if isinstance(it, WatchlistCodeItem):
                if it.code in seen_codes:
                    continue
                seen_codes.add(it.code)
            elif it.id in seen_memo_ids:
                log.warning("watchlist.drift: duplicate memo id %s (dropped)", it.id)
                continue
            else:
                seen_memo_ids.add(it.id)
            out.append(it)
        return out

    # 물리 리스트 순서로 순회 — 메모 dedupe 가 "첫 등장" 을 폴더 간에도 결정하므로
    # 순회 순서가 결과에 들어간다. 파일에 적힌 순서를 그대로 쓴다(order 정규화와 무관).
    new_folders = [f.model_copy(update={"order": fo[i], "items": dedupe(f.items)})
                   for i, f in enumerate(doc.folders)]
    return doc.model_copy(update={"folders": new_folders})


def _prune_orphans(doc: WatchlistDocument) -> WatchlistDocument:
    """불변식 강제(ADR-0070): entry 존재 ⟺ 어떤 폴더의 **code item** 에 있음. 어느 폴더에도
    없는 entry(orphan)를 제거한다. **write 경로(save_document)에서만** — read 경로(load)는
    drift를 보존·loud-log해야 한다(ADR-0065: read 에서 wipe 금지). 생성 절반(모든 member 에
    entry 존재)은 disk-seed 가 필요해 add_member(write 경로)가 책임진다. 순수·idempotent.

    이 한 곳이 prune 의 단일 소유자라, 멤버십을 줄이는 mutation(remove_member/remove_entry/
    remove_entries/delete_folder)은 items 만 손대면 entry 정리는 자동이다.

    메모 item 은 이 불변식 밖이다 — 코드가 아니므로 entry 를 갖지 않고, 여기서 세지도
    않는다(세면 메모만 든 폴더가 모든 entry 를 살려 두는 꼴이 된다).
    """
    members = {c for f in doc.folders for c in f.code_members()}
    kept = [e for e in doc.entries if e.code in members]
    if len(kept) == len(doc.entries):
        return doc
    return doc.model_copy(update={"entries": kept})


def load_document(data_dir: Path) -> WatchlistDocument:
    """Read watchlist.json as a v4 WatchlistDocument. Missing → empty doc.
    Forward-migrates v1/v2/v3 in place (never quarantines — ADR-0065). Genuine
    corruption (invalid JSON / schema-violating entries / unknown item kind) →
    backup + empty, matching the prior behaviour; OSError propagates."""
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
    """Atomic write of the WHOLE v4 document. The only write path — so it is the
    single seam that ENFORCES the invariant: _reindex normalizes folder order +
    dedupes items, then _prune_orphans drops entries no longer in any folder.
    Mutations need only adjust items; orphan cleanup is automatic."""
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
    """code 를 folder_id 의 멤버로 추가(v4, ADR-0070). entry 가 없으면 생성하고
    last_success 를 디스크에서 시드(첫 Watchlist 진입). 이미 멤버면 멱등 no-op.
    폴더 없으면 FolderNotFoundError. 불변식 {e.code}==⋃code items 유지."""
    # Local import: disk_state -> watchlist would cycle if at module top.
    from hoga.api.disk_state import (  # noqa: PLC0415 — 지연 import(순환/heavy)
        latest_complete_date,
    )
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
        if code not in folder.code_members():  # idempotent: already a member → no-op
            # 맨 뒤에 붙인다 — 메모가 섞여 있어도 코드는 items 끝으로 간다(v3 와 동일).
            new_folders = [f.model_copy(update={"items": [*f.items, WatchlistCodeItem(code=code)]})
                           if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders, "entries": entries}))
        return entry


async def remove_member(data_dir: Path, *, code: str, folder_id: str) -> None:
    """code 를 folder_id 에서 제거(v4). 제거 후 어느 폴더에도 없으면 entry 삭제
    (Watchlist 탈락). 폴더 없으면 FolderNotFoundError. 멤버 아니면 멱등 no-op."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(f.id == folder_id for f in doc.folders):
            raise FolderNotFoundError(folder_id)
        new_folders = [f.model_copy(update={"items": _without_codes(f.items, {code})})
                       if f.id == folder_id else f for f in doc.folders]
        # items 만 손댄다 — code 가 어느 폴더에도 없게 되면 save_document 가 orphan
        # entry 를 자동 prune 한다(불변식 단일 소유, ADR-0070).
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


async def remove_entry(data_dir: Path, *, code: str) -> None:
    """code 를 Watchlist 에서 완전 제거(모든 폴더 items 에서 뺀다 → save 가 entry prune)."""
    async with _lock:
        doc = load_document(data_dir)
        if not any(e.code == code for e in doc.entries):
            raise NotInWatchlistError(code)
        new_folders = [f.model_copy(update={"items": _without_codes(f.items, {code})})
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
                                 order=len(doc.folders), items=[],
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
                               items=f.items, capture_enabled=f.capture_enabled)
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
    """folder_id 의 **코드 순서**를 ordered_codes 로 재배열(v4). ordered_codes 는
    현재 코드 멤버 집합과 정확히 일치해야 함(아니면 WatchlistSetMismatchError → 409).

    메모 item 은 **items 인덱스에 고정**된 채 남는다 — 코드 슬롯에만 새 순서를 채운다.
    즉 코드끼리는 자유롭게 재배열되지만 메모를 뛰어넘지는 않는다. 이 계약은 메모를
    만들 UI 가 없는 동안에는 v3 와 완전히 동일하게 동작한다(메모가 0개이므로).
    메모를 포함한 자유 재배열은 후속 `ordered_items` 계약이 담당한다.
    """
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        current = folder.code_members()
        if len(ordered_codes) != len(current) or set(ordered_codes) != set(current):
            raise WatchlistSetMismatchError(
                f"reorder set {ordered_codes} != folder {folder_id} members {current}")
        fill = iter(ordered_codes)
        new_items = [WatchlistCodeItem(code=next(fill)) if isinstance(i, WatchlistCodeItem) else i
                     for i in folder.items]
        new_folders = [f.model_copy(update={"items": new_items})
                       if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


def _item_key(item: WatchlistCodeItem | WatchlistMemoItem) -> tuple[str, str]:
    """items 원소의 동일성 키 — 코드와 메모 id 가 같은 네임스페이스를 쓰지 않게
    kind 를 함께 담는다(`("code","005930")` vs `("memo","m_…")`)."""
    return ("code", item.code) if isinstance(item, WatchlistCodeItem) else ("memo", item.id)


async def reorder_items(
    data_dir: Path,
    *,
    folder_id: str,
    ordered_keys: list[tuple[str, str]],
) -> None:
    """folder_id 의 items 를 ordered_keys 순서로 재배열(v4). 코드와 메모를 함께 옮긴다.

    ordered_keys 는 현재 items 집합과 정확히 일치해야 한다(아니면
    WatchlistSetMismatchError → 409) — reorder_entries 와 같은 authoritative-list
    계약이다. 메모 `text` 는 옮기지 않는다: 기존 아이템 객체를 키로 찾아 재배치할
    뿐이라 내용이 요청에 실릴 필요가 없다.
    """
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        by_key = {_item_key(i): i for i in folder.items}
        if len(ordered_keys) != len(by_key) or set(ordered_keys) != set(by_key):
            raise WatchlistSetMismatchError(
                f"reorder set {ordered_keys} != folder {folder_id} items {list(by_key)}")
        new_items = [by_key[k] for k in ordered_keys]
        new_folders = [f.model_copy(update={"items": new_items})
                       if f.id == folder_id else f for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


async def remove_entries(data_dir: Path, *, codes: list[str]) -> None:
    """Bulk remove from the Watchlist (v4): drop the codes from every folder's
    items and delete their entries. Absent codes ignored (idempotent)."""
    async with _lock:
        doc = load_document(data_dir)
        drop = set(codes)
        # items 에서만 빼면 save_document 가 orphan entry 들을 prune 한다.
        new_folders = [f.model_copy(update={"items": _without_codes(f.items, drop)})
                       for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))


# --- 메모("빈칸") 아이템 CRUD (v4) -----------------------------------------
# 메모는 폴더 items 안에서만 산다 — entry 도, 캡처 대상도 아니다. 그래서 이 세
# 함수는 불변식({e.code}==⋃code items)을 건드리지 않고, _prune_orphans 도 이들이
# 만든 문서를 그대로 통과시킨다.


class MemoNotFoundError(Exception):
    """Raised when a memo id is absent from every folder."""


def _mint_memo_id() -> str:
    return "m_" + secrets.token_hex(4)


async def add_memo(
    data_dir: Path,
    *,
    folder_id: str,
    text: str = "",
    at: int | None = None,
) -> tuple[WatchlistMemoItem, int]:
    """folder_id 의 items 에 메모를 삽입하고 (아이템, 최종 인덱스)를 반환한다.

    `at` = 삽입할 items 인덱스. None 이거나 범위를 벗어나면 맨 뒤로 클램프한다 —
    동시 편집으로 길이가 줄었을 뿐인 흔한 경우라 422 로 거절할 이유가 없다.
    폴더 없으면 FolderNotFoundError.
    """
    async with _lock:
        doc = load_document(data_dir)
        folder = next((f for f in doc.folders if f.id == folder_id), None)
        if folder is None:
            raise FolderNotFoundError(folder_id)
        used = {i.id for f in doc.folders for i in f.items if isinstance(i, WatchlistMemoItem)}
        memo_id = _mint_memo_id()
        while memo_id in used:  # secrets 라 사실상 안 돌지만, 충돌 시 조용히 덮지 않는다
            memo_id = _mint_memo_id()
        memo = WatchlistMemoItem(id=memo_id, text=text)
        index = len(folder.items) if at is None else min(at, len(folder.items))
        new_items = [*folder.items[:index], memo, *folder.items[index:]]
        new_folders = [f.model_copy(update={"items": new_items}) if f.id == folder_id else f
                       for f in doc.folders]
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))
        return memo, index


async def update_memo(data_dir: Path, *, memo_id: str, text: str) -> tuple[WatchlistMemoItem, str, int]:
    """메모 텍스트를 교체하고 (아이템, folder_id, items 인덱스)를 반환한다.

    memo_id 는 문서 전역 유니크(_reindex 가 강제)라 folder_id 없이 찾는다.
    없으면 MemoNotFoundError.
    """
    async with _lock:
        doc = load_document(data_dir)
        for folder in doc.folders:
            for index, item in enumerate(folder.items):
                if isinstance(item, WatchlistMemoItem) and item.id == memo_id:
                    updated = item.model_copy(update={"text": text})
                    new_items = [*folder.items[:index], updated, *folder.items[index + 1:]]
                    new_folders = [f.model_copy(update={"items": new_items})
                                   if f.id == folder.id else f for f in doc.folders]
                    save_document(data_dir, doc.model_copy(update={"folders": new_folders}))
                    return updated, folder.id, index
        raise MemoNotFoundError(memo_id)


async def remove_memo(data_dir: Path, *, memo_id: str) -> None:
    """메모를 삭제한다. 없으면 MemoNotFoundError(멱등 no-op 이 아니다 — 프론트가
    이미 지운 행을 다시 지우는 흐름이 없고, 조용한 성공은 오타를 숨긴다)."""
    async with _lock:
        doc = load_document(data_dir)
        found = False
        new_folders = []
        for f in doc.folders:
            kept = [i for i in f.items
                    if not (isinstance(i, WatchlistMemoItem) and i.id == memo_id)]
            if len(kept) != len(f.items):
                found = True
            new_folders.append(f.model_copy(update={"items": kept}))
        if not found:
            raise MemoNotFoundError(memo_id)
        save_document(data_dir, doc.model_copy(update={"folders": new_folders}))
