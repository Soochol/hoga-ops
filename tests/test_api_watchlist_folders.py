"""Watchlist v3: folders own member_codes + document envelope + migration.
See docs/adr/0069-watchlist-v3-multi-membership.md, 2026-05-31 folders, ADR-0055/0065."""
from __future__ import annotations

import asyncio
import json

import pytest


async def _seed(tmp_path, fid, items):
    """Add (code, name) items into folder fid as members (v3)."""
    from hoga.api.watchlist import add_member
    for c, n in items:
        await add_member(tmp_path, code=c, name=n, today_kst_date="20260101", folder_id=fid)


def test_folder_model_fields():
    from hoga.api.models import WatchlistFolder
    # id must match ^f_[0-9a-f]{8}$ (what _mint_folder_id produces); use a
    # pattern-valid literal in fixtures or Pydantic rejects at construction.
    f = WatchlistFolder(id="f_0000000a", name="스윙", order=0)
    assert f.id == "f_0000000a"
    assert f.name == "스윙"
    assert f.order == 0
    assert f.member_codes == []


def test_watchlist_folder_defaults_capture_enabled_true_for_direct_model() -> None:
    from hoga.api.models import WatchlistFolder

    folder = WatchlistFolder(id="f_0000000a", name="스윙", order=0)

    assert folder.capture_enabled is True


def test_migrate_v1_to_v3_default_folder(tmp_path):
    """v1 (folder-less) → v3: unfiled Codes preserved into a '기본' folder."""
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자", "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "000660", "name": "SK하이닉스", "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    assert [f.name for f in doc.folders] == ["기본"]
    assert doc.folders[0].member_codes == ["005930", "000660"]
    assert {e.code for e in doc.entries} == {"005930", "000660"}


def test_migrate_is_idempotent(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0, member_codes=["005930"])],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.schema_version == 3
    assert reloaded.folders[0].id == "f_0000000a"
    assert reloaded.folders[0].member_codes == ["005930"]


def test_migrate_existing_v3_folder_without_capture_enabled_defaults_true(tmp_path):
    from hoga.api.watchlist import load_document

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3,
        "folders": [{
            "id": "f_0000000a",
            "name": "스윙",
            "order": 0,
            "member_codes": ["005930"],
        }],
        "entries": [{
            "code": "005930",
            "name": "삼성전자",
            "registered_at_kst_date": "20260101",
            "last_success_date": None,
        }],
    }), encoding="utf-8")

    doc = load_document(tmp_path)

    assert doc.folders[0].capture_enabled is True


def test_bump_last_success_preserves_folders(tmp_path):
    """Blocker #1 regression: the Scheduler's bump must NOT drop folders/members."""
    from hoga.api.watchlist import load_document, save_document, bump_last_success
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0, member_codes=["005930"])],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None)],
    ))
    asyncio.run(bump_last_success(tmp_path, code="005930", date="20260102"))
    doc = load_document(tmp_path)
    assert doc.folders[0].id == "f_0000000a"                 # folder survived
    assert doc.folders[0].member_codes == ["005930"]         # membership survived
    assert doc.entries[0].last_success_date == "20260102"


def test_future_version_raises_not_downgrades(tmp_path):
    """ADR-0065 rule 1: a FUTURE schema_version (>3) must raise, not be clobbered.
    Raised as UnsupportedWatchlistSchema (not ValueError) so the corruption-backup
    path can catch malformed ValueErrors without swallowing it."""
    from hoga.api.watchlist import load_document, UnsupportedWatchlistSchema
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 4, "folders": [], "entries": [],
    }), encoding="utf-8")
    with pytest.raises(UnsupportedWatchlistSchema, match="unsupported watchlist schema_version"):
        load_document(tmp_path)


def test_load_nondict_corruption_backs_up_not_crashes(tmp_path):
    """A malformed shape (non-dict / non-list entries) trips _migrate's structural
    ops → TypeError/AttributeError/ValueError. load_document must treat it as
    corruption (backup + empty), NOT crash the read path (ADR-0065)."""
    from hoga.api.watchlist import load_document
    for bad in ([123, "notadict"], "entries-not-a-list", {"id": "x"}):
        (tmp_path / "watchlist.json").write_text(
            json.dumps({"schema_version": 2, "folders": [], "entries": bad}),
            encoding="utf-8")
        doc = load_document(tmp_path)  # must not raise
        assert doc.entries == [] and doc.folders == []
        assert list(tmp_path.glob("watchlist.json.corrupt-*"))
        for b in tmp_path.glob("watchlist.json.corrupt-*"):
            b.unlink()  # reset for the next iteration


def test_create_folder_mints_id_and_appends(tmp_path):
    from hoga.api.watchlist import create_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    assert f.id.startswith("f_") and len(f.id) == 10
    assert f.name == "스윙" and f.order == 0
    f2 = asyncio.run(create_folder(tmp_path, name="장기투자"))
    assert f2.order == 1
    assert [x.id for x in load_document(tmp_path).folders] == [f.id, f2.id]


def test_new_folder_defaults_capture_disabled(tmp_path):
    from hoga.api.watchlist import create_folder, load_document

    folder = asyncio.run(create_folder(tmp_path, name="신규"))

    assert folder.capture_enabled is False
    assert load_document(tmp_path).folders[0].capture_enabled is False


def test_set_folder_capture_enabled_persists(tmp_path):
    from hoga.api.watchlist import create_folder, load_document, set_folder_capture_enabled

    folder = asyncio.run(create_folder(tmp_path, name="스윙"))
    updated = asyncio.run(set_folder_capture_enabled(
        tmp_path,
        folder_id=folder.id,
        capture_enabled=True,
    ))

    assert updated.capture_enabled is True
    assert load_document(tmp_path).folders[0].capture_enabled is True


def test_rename_folder_keeps_id(tmp_path):
    from hoga.api.watchlist import create_folder, rename_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(rename_folder(tmp_path, folder_id=f.id, name="단타"))
    folders = load_document(tmp_path).folders
    assert folders[0].id == f.id and folders[0].name == "단타"


def test_delete_folder_drops_sole_members_keeps_shared(tmp_path):
    """v3 (ADR-0070): deleting a folder drops a Code that was only in it
    (entry deleted), but a Code also in another folder survives."""
    from hoga.api.watchlist import create_folder, delete_folder, load_document
    f1 = asyncio.run(create_folder(tmp_path, name="스윙"))
    f2 = asyncio.run(create_folder(tmp_path, name="장기"))
    asyncio.run(_seed(tmp_path, f1.id, [("005930", "삼성"), ("000660", "SK")]))
    asyncio.run(_seed(tmp_path, f2.id, [("005930", "삼성")]))  # 005930 shared
    asyncio.run(delete_folder(tmp_path, folder_id=f1.id))
    doc = load_document(tmp_path)
    assert [x.id for x in doc.folders] == [f2.id]
    assert {e.code for e in doc.entries} == {"005930"}  # 000660 orphaned → dropped


def test_reorder_folders(tmp_path):
    from hoga.api.watchlist import create_folder, reorder_folders, load_document
    a = asyncio.run(create_folder(tmp_path, name="A"))
    b = asyncio.run(create_folder(tmp_path, name="B"))
    asyncio.run(reorder_folders(tmp_path, ordered_ids=[b.id, a.id]))
    assert [f.name for f in load_document(tmp_path).folders] == ["B", "A"]


@pytest.mark.parametrize("bad_name", ["   ", "x" * 41])
def test_rename_to_invalid_name_rejects_without_corrupting(tmp_path, bad_name):
    """An invalid rename must be rejected BEFORE the write, leaving the watchlist
    intact (model_copy(update=...) would skip validation and quarantine on next load)."""
    from pydantic import ValidationError
    from hoga.api.watchlist import create_folder, rename_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    with pytest.raises(ValidationError):
        asyncio.run(rename_folder(tmp_path, folder_id=f.id, name=bad_name))
    doc = load_document(tmp_path)
    assert [x.id for x in doc.folders] == [f.id]   # folder survived
    assert doc.folders[0].name == "스윙"             # name unchanged
    assert not list(tmp_path.glob("watchlist.json.corrupt-*"))  # not wiped


def test_create_folder_with_whitespace_name_rejects(tmp_path):
    from pydantic import ValidationError
    from hoga.api.watchlist import create_folder
    with pytest.raises(ValidationError):
        asyncio.run(create_folder(tmp_path, name="   "))


def test_rename_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import create_folder, rename_folder, FolderNotFoundError
    asyncio.run(create_folder(tmp_path, name="스윙"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(rename_folder(tmp_path, folder_id="f_deadbeef", name="단타"))


def test_delete_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import create_folder, delete_folder, FolderNotFoundError
    asyncio.run(create_folder(tmp_path, name="스윙"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(delete_folder(tmp_path, folder_id="f_deadbeef"))


def test_reorder_folders_mismatched_set_raises(tmp_path):
    """ordered_ids that don't match the current folder set are rejected (409)."""
    from hoga.api.watchlist import create_folder, reorder_folders, WatchlistSetMismatchError
    a = asyncio.run(create_folder(tmp_path, name="A"))
    asyncio.run(create_folder(tmp_path, name="B"))
    with pytest.raises(WatchlistSetMismatchError):
        asyncio.run(reorder_folders(tmp_path, ordered_ids=[a.id, "f_deadbeef"]))


def test_add_member_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import add_member, FolderNotFoundError
    with pytest.raises(FolderNotFoundError):
        asyncio.run(add_member(tmp_path, code="005930", name="삼성전자",
                               today_kst_date="20260101", folder_id="f_deadbeef"))


def test_reorder_entries_mismatched_set_raises(tmp_path):
    """ordered_codes must be exactly the folder's current members (else 409)."""
    from hoga.api.watchlist import create_folder, reorder_entries, WatchlistSetMismatchError
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(_seed(tmp_path, f.id, [("005930", "삼성"), ("000660", "SK")]))
    with pytest.raises(WatchlistSetMismatchError):
        asyncio.run(reorder_entries(tmp_path, folder_id=f.id, ordered_codes=["005930"]))


def test_reorder_entries_within_folder(tmp_path):
    from hoga.api.watchlist import create_folder, reorder_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(_seed(tmp_path, f.id, [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]))
    asyncio.run(reorder_entries(tmp_path, folder_id=f.id,
                                ordered_codes=["035720", "005930", "000660"]))
    doc = load_document(tmp_path)
    assert doc.folders[0].member_codes == ["035720", "005930", "000660"]


def test_remove_entries_bulk(tmp_path):
    from hoga.api.watchlist import create_folder, remove_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(_seed(tmp_path, f.id, [("005930", "삼성"), ("000660", "SK")]))
    asyncio.run(remove_entries(tmp_path, codes=["005930", "000660"]))
    doc = load_document(tmp_path)
    assert doc.entries == []
    assert doc.folders[0].member_codes == []
