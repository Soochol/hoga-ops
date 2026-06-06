"""Watchlist v2: folders + document envelope + referential integrity.
See spec 2026-05-31-watchlist-folders-design.md, ADR-0055."""
from __future__ import annotations

import pytest
from pydantic import ValidationError


def test_folder_model_fields():
    from hoga.api.models import WatchlistFolder
    # id must match ^f_[0-9a-f]{8}$ (what _mint_folder_id produces); use a
    # pattern-valid literal in fixtures or Pydantic rejects at construction.
    f = WatchlistFolder(id="f_0000000a", name="스윙", order=0)
    assert f.id == "f_0000000a"
    assert f.name == "스윙"
    assert f.order == 0


def test_entry_defaults_folder_id_null_order_zero():
    from hoga.api.models import WatchlistEntry
    e = WatchlistEntry(code="005930", name="삼성전자",
                       registered_at_kst_date="20260101", last_success_date=None)
    assert e.folder_id is None
    assert e.order == 0


def test_document_rejects_dangling_folder_id():
    from hoga.api.models import WatchlistDocument, WatchlistEntry
    # f_deadbeef is pattern-VALID (8 hex) but absent from folders, so the
    # failure must originate in the document-level _no_dangling_folder_id
    # validator — NOT WatchlistEntry field-pattern validation. match= pins
    # that the referential-integrity validator (the point of B1) actually ran.
    with pytest.raises(ValidationError, match="unknown folder"):
        WatchlistDocument(
            schema_version=2,
            folders=[],
            entries=[WatchlistEntry(code="005930", name="삼성전자",
                                    registered_at_kst_date="20260101",
                                    last_success_date=None, folder_id="f_deadbeef")],
        )


def test_document_accepts_null_and_valid_folder_id():
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        schema_version=2,
        folders=[WatchlistFolder(id="f_0000000b", name="스윙", order=0)],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260101",
                           last_success_date=None, folder_id="f_0000000b", order=0),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260101",
                           last_success_date=None, folder_id=None, order=0),
        ],
    )
    assert len(doc.entries) == 2


def test_migrate_v1_seeds_order_and_empty_folders(tmp_path):
    import json
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자", "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "000660", "name": "SK하이닉스", "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 2
    assert doc.folders == []
    assert [e.code for e in doc.entries] == ["005930", "000660"]
    assert [e.order for e in doc.entries] == [0, 1]  # 미분류 group reindexed
    assert all(e.folder_id is None for e in doc.entries)


def test_migrate_is_idempotent(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0)],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None,
                                folder_id="f_0000000a", order=0)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.schema_version == 2
    assert reloaded.folders[0].id == "f_0000000a"
    assert reloaded.entries[0].folder_id == "f_0000000a"


def test_load_repairs_dangling_folder_id_without_wiping(tmp_path):
    import json
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [],
        "entries": [{"code": "005930", "name": "삼성전자", "registered_at_kst_date": "20260101",
                     "last_success_date": None, "folder_id": "f_ghost", "order": 0}],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    # repaired (folder_id nulled), NOT backed-up-and-emptied
    assert len(doc.entries) == 1
    assert doc.entries[0].folder_id is None
    assert not list(tmp_path.glob("watchlist.json.corrupt-*"))


def test_bump_last_success_preserves_folders(tmp_path):
    """Blocker #1 regression: the Scheduler's bump must NOT drop folders."""
    import asyncio
    from hoga.api.watchlist import load_document, save_document, bump_last_success
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0)],
        entries=[WatchlistEntry(code="005930", name="삼성전자",
                                registered_at_kst_date="20260101", last_success_date=None,
                                folder_id="f_0000000a", order=0)],
    ))
    asyncio.run(bump_last_success(tmp_path, code="005930", date="20260102"))
    doc = load_document(tmp_path)
    assert doc.folders[0].id == "f_0000000a"          # folder survived
    assert doc.entries[0].folder_id == "f_0000000a"   # membership survived
    assert doc.entries[0].last_success_date == "20260102"


def test_future_version_raises_not_downgrades(tmp_path):
    """ADR-0055 rule 1: a future schema_version must raise, not be clobbered to v2.
    Raised as the dedicated UnsupportedWatchlistSchema (not a ValueError) so the
    corruption-backup path can catch malformed ValueErrors without swallowing it."""
    import json
    import pytest
    from hoga.api.watchlist import load_document, UnsupportedWatchlistSchema
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3, "folders": [], "entries": [],
    }), encoding="utf-8")
    with pytest.raises(UnsupportedWatchlistSchema, match="unsupported watchlist schema_version"):
        load_document(tmp_path)


def test_load_nondict_corruption_backs_up_not_crashes(tmp_path):
    """A malformed shape (non-dict / non-list entries) trips _migrate's structural
    ops (dict(e), .get) → TypeError/AttributeError/ValueError. load_document must
    treat it as corruption (backup + empty), NOT crash the read path (ADR-0055)."""
    import json
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


def test_move_into_own_folder_keeps_position(tmp_path):
    """Moving a code into the folder it already occupies is a no-op — it must NOT
    jump to the bottom of that folder (/code-review move_entries finding)."""
    import asyncio
    from hoga.api.watchlist import create_folder, add_entry, move_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["005930", "000660", "035720"], folder_id=f.id))
    before = {e.code: e.order for e in load_document(tmp_path).entries}
    assert before["005930"] == 0  # first
    # move the first entry into the folder it is ALREADY in → must stay put
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=f.id))
    after = {e.code: e.order for e in load_document(tmp_path).entries}
    assert after == before
    assert after["005930"] == 0  # still first, not bottom


def test_add_entry_lands_last_in_unfiled_group(tmp_path, monkeypatch):
    """A new Code must sort LAST in 미분류 by `order`, not slot into second.

    Regression: add_entry seeded order=0, which tied the first existing entry;
    _reindex ranks by (order, flat_index) with order primary, so the new Code
    landed in slot 1 and bumped the prior tail to slot 2. Seed len(entries) so
    it exceeds every per-group order and compresses to the final slot."""
    import asyncio
    from hoga.api import disk_state, watchlist
    monkeypatch.setattr(disk_state, "latest_complete_date", lambda _dir, _code: None)
    asyncio.run(watchlist.add_entry(tmp_path, code="000001", name="A",
                                    today_kst_date="20260531"))
    asyncio.run(watchlist.add_entry(tmp_path, code="000002", name="B",
                                    today_kst_date="20260531"))
    asyncio.run(watchlist.add_entry(tmp_path, code="000003", name="C",
                                    today_kst_date="20260531"))
    doc = watchlist.load_document(tmp_path)
    by_code = {e.code: e.order for e in doc.entries}
    # newest Code carries the highest order in its (null) group → renders last
    assert by_code == {"000001": 0, "000002": 1, "000003": 2}


def test_create_folder_mints_id_and_appends(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    assert f.id.startswith("f_") and len(f.id) == 10
    assert f.name == "스윙" and f.order == 0
    f2 = asyncio.run(create_folder(tmp_path, name="장기투자"))
    assert f2.order == 1
    assert [x.id for x in load_document(tmp_path).folders] == [f.id, f2.id]


def test_rename_folder_keeps_id(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, rename_folder, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(rename_folder(tmp_path, folder_id=f.id, name="단타"))
    folders = load_document(tmp_path).folders
    assert folders[0].id == f.id and folders[0].name == "단타"


def test_delete_folder_reparents_members_to_null(tmp_path):
    import asyncio
    from hoga.api.watchlist import (create_folder, add_entry,
                                    delete_folder, load_document,
                                    save_document)
    from hoga.api.models import WatchlistEntry
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    # Establish folder membership directly (move_entries is Task B4); the
    # precondition under test is "an entry whose folder_id == f.id".
    doc = load_document(tmp_path)
    members = [e.model_copy(update={"folder_id": f.id}) for e in doc.entries]
    save_document(tmp_path, doc.model_copy(update={"entries": members}))
    asyncio.run(delete_folder(tmp_path, folder_id=f.id))
    doc = load_document(tmp_path)
    assert doc.folders == []
    assert doc.entries[0].folder_id is None   # reparented, not deleted


def test_reorder_folders(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, reorder_folders, load_document
    a = asyncio.run(create_folder(tmp_path, name="A"))
    b = asyncio.run(create_folder(tmp_path, name="B"))
    asyncio.run(reorder_folders(tmp_path, ordered_ids=[b.id, a.id]))
    assert [f.name for f in load_document(tmp_path).folders] == ["B", "A"]


@pytest.mark.parametrize("bad_name", ["   ", "x" * 41])
def test_rename_to_invalid_name_rejects_without_corrupting(tmp_path, bad_name):
    """Critical: an invalid rename must be rejected BEFORE the write, leaving
    the watchlist intact. The bug was model_copy(update=...) skipping
    validation, so a whitespace-only ("" after strip < min_length=1) or
    over-length (>40 after strip) name got persisted unchecked and then
    quarantined the whole document on the next load (ADR-0055). The
    survival assertions — original folder still loads, no corrupt-* backup —
    are what verify the fix, not merely the raised exception."""
    import asyncio
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
    """Guards the other end of the shared validation: factoring rename through
    WatchlistFolder must not change create_folder's existing behavior — a
    whitespace-only name still raises at construction (the safe asymmetry)."""
    import asyncio
    from pydantic import ValidationError
    from hoga.api.watchlist import create_folder
    with pytest.raises(ValidationError):
        asyncio.run(create_folder(tmp_path, name="   "))


def test_rename_unknown_folder_raises(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, rename_folder, FolderNotFoundError
    asyncio.run(create_folder(tmp_path, name="스윙"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(rename_folder(tmp_path, folder_id="f_deadbeef", name="단타"))


def test_delete_unknown_folder_raises(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, delete_folder, FolderNotFoundError
    asyncio.run(create_folder(tmp_path, name="스윙"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(delete_folder(tmp_path, folder_id="f_deadbeef"))


def test_reorder_folders_mismatched_set_raises(tmp_path):
    """ordered_ids that don't match the current folder set are rejected so the
    client and server can't drift (extra id, missing id, or wrong cardinality)."""
    import asyncio
    from hoga.api.watchlist import create_folder, reorder_folders, WatchlistSetMismatchError
    a = asyncio.run(create_folder(tmp_path, name="A"))
    b = asyncio.run(create_folder(tmp_path, name="B"))
    with pytest.raises(WatchlistSetMismatchError):
        # drops b.id and injects an unknown id → set mismatch (a 409, NOT a 404 "not found")
        asyncio.run(reorder_folders(tmp_path, ordered_ids=[a.id, "f_deadbeef"]))


def test_reorder_entries_mismatched_set_raises(tmp_path):
    """ordered_codes must be exactly the codes currently in the folder; a mismatch
    (subset / foreign code) is a set-mismatch (409), not a single-code 'absent' (404)."""
    import asyncio
    from hoga.api.watchlist import add_entry, reorder_entries, WatchlistSetMismatchError
    for c, n in [("005930", "삼성"), ("000660", "SK")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    with pytest.raises(WatchlistSetMismatchError):
        asyncio.run(reorder_entries(tmp_path, folder_id=None, ordered_codes=["005930"]))


def test_move_entries_sets_folder_and_appends_order(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, add_entry, move_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    for c, n in [("005930", "삼성전자"), ("000660", "SK하이닉스")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["000660", "005930"], folder_id=f.id))
    doc = load_document(tmp_path)
    moved = {e.code: e for e in doc.entries}
    assert moved["000660"].folder_id == f.id and moved["005930"].folder_id == f.id
    # contiguous 0..1 within the target folder
    assert sorted(e.order for e in doc.entries if e.folder_id == f.id) == [0, 1]


def test_move_to_null_uncategorizes(tmp_path):
    import asyncio
    from hoga.api.watchlist import create_folder, add_entry, move_entries, load_document
    f = asyncio.run(create_folder(tmp_path, name="스윙"))
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=f.id))
    asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id=None))
    assert load_document(tmp_path).entries[0].folder_id is None


def test_move_to_unknown_folder_raises(tmp_path):
    import asyncio
    import pytest
    from hoga.api.watchlist import add_entry, move_entries, FolderNotFoundError
    asyncio.run(add_entry(tmp_path, code="005930", name="삼성전자", today_kst_date="20260101"))
    with pytest.raises(FolderNotFoundError):
        asyncio.run(move_entries(tmp_path, codes=["005930"], folder_id="f_deadbeef"))


def test_reorder_entries_within_folder(tmp_path):
    import asyncio
    from hoga.api.watchlist import add_entry, reorder_entries, load_document
    for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(reorder_entries(tmp_path, folder_id=None, ordered_codes=["035720", "005930", "000660"]))
    doc = load_document(tmp_path)
    by_order = sorted(doc.entries, key=lambda e: e.order)
    assert [e.code for e in by_order] == ["035720", "005930", "000660"]


def test_remove_entries_bulk(tmp_path):
    import asyncio
    from hoga.api.watchlist import add_entry, remove_entries, load_document
    for c, n in [("005930", "삼성"), ("000660", "SK")]:
        asyncio.run(add_entry(tmp_path, code=c, name=n, today_kst_date="20260101"))
    asyncio.run(remove_entries(tmp_path, codes=["005930", "000660"]))
    assert load_document(tmp_path).entries == []
