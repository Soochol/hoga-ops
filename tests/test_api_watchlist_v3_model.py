"""Watchlist v4: 폴더가 items(코드+메모) 소유, entry는 순수 백필 레코드.
와이어(WatchlistResponse)는 펼친 view(folder_id+order) — Entity≠Wire(ADR-0004/0069)."""
from __future__ import annotations


def test_folder_has_items_default_empty():
    from hoga.api.models import WatchlistFolder, code_items
    f = WatchlistFolder(id="f_0000000a", name="스윙", order=0)
    assert f.code_members() == []
    f2 = WatchlistFolder(id="f_0000000b", name="장기", order=1, items=code_items(["005930", "000660"]))
    assert f2.code_members() == ["005930", "000660"]


def test_entry_has_no_folder_fields():
    from hoga.api.models import WatchlistEntry
    e = WatchlistEntry(code="005930", name="삼성전자",
                       registered_at_kst_date="20260101", last_success_date=None)
    assert not hasattr(e, "folder_id")
    assert not hasattr(e, "order")


def test_document_default_version():
    from hoga.api.models import WatchlistDocument
    assert WatchlistDocument().schema_version == 4


def test_wire_view_models_carry_folder_and_order():
    from hoga.api.models import WatchlistEntryView, WatchlistFolderView
    fv = WatchlistFolderView(id="f_0000000a", name="스윙", order=0)
    assert not hasattr(fv, "member_codes")
    ev = WatchlistEntryView(code="005930", name="삼성전자",
                            registered_at_kst_date="20260101", last_success_date=None,
                            folder_id="f_0000000a", order=0)
    assert ev.folder_id == "f_0000000a"
    assert ev.order == 0
