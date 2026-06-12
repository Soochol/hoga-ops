"""v2→v3 마이그레이션: folder_id/order → member_codes, null → '기본' 보존 폴더."""
from __future__ import annotations
import json


def test_migrate_v2_folds_folder_id_into_member_codes(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [{"id": "f_0000000a", "name": "스윙", "order": 0}],
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": "f_0000000a", "order": 1},
            {"code": "000660", "name": "SK", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": "f_0000000a", "order": 0},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    swing = next(f for f in doc.folders if f.id == "f_0000000a")
    assert swing.member_codes == ["000660", "005930"]  # by order
    assert {e.code for e in doc.entries} == {"005930", "000660"}


def test_migrate_v2_nulls_go_to_default_folder(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2, "folders": [],
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
             "last_success_date": None, "folder_id": None, "order": 0},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    assert len(doc.folders) == 1
    assert doc.folders[0].name == "기본"
    assert doc.folders[0].member_codes == ["005930"]


def test_migrate_v2_no_nulls_no_default_folder(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 2,
        "folders": [{"id": "f_0000000a", "name": "스윙", "order": 0}],
        "entries": [{"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
                     "last_success_date": None, "folder_id": "f_0000000a", "order": 0}],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert [f.name for f in doc.folders] == ["스윙"]  # no '기본'


def test_migrate_v1_legacy_nulls_to_default(tmp_path):
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "000660", "name": "SK", "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 3
    assert [f.name for f in doc.folders] == ["기본"]
    assert doc.folders[0].member_codes == ["005930", "000660"]


def test_migrate_v3_passthrough_is_idempotent(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0, member_codes=["005930"])],
        entries=[WatchlistEntry(code="005930", name="삼성",
                                registered_at_kst_date="20260101", last_success_date=None)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.schema_version == 3
    assert reloaded.folders[0].member_codes == ["005930"]


def test_reindex_dedupes_member_codes_and_normalizes_order(tmp_path):
    from hoga.api.watchlist import load_document, save_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=5,
                                 member_codes=["005930", "005930", "000660"])],
        entries=[WatchlistEntry(code="005930", name="삼성", registered_at_kst_date="20260101", last_success_date=None),
                 WatchlistEntry(code="000660", name="SK", registered_at_kst_date="20260101", last_success_date=None)],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.folders[0].order == 0  # normalized
    assert reloaded.folders[0].member_codes == ["005930", "000660"]  # deduped, first-occurrence


def test_migrate_rejects_future_version(tmp_path):
    import pytest
    from hoga.api.watchlist import load_document, UnsupportedWatchlistSchema
    (tmp_path / "watchlist.json").write_text(json.dumps({"schema_version": 4, "folders": [], "entries": []}),
                                             encoding="utf-8")
    with pytest.raises(UnsupportedWatchlistSchema):
        load_document(tmp_path)
