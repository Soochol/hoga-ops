"""불변식 단일 소유(ADR-0069): save_document 가 orphan entry 를 prune; read 는 안 함."""
from __future__ import annotations
import json

import pytest


def test_save_document_prunes_orphan_entries(tmp_path):
    """어느 폴더 member_codes 에도 없는 entry 는 write 경로(save)가 자동 제거한다."""
    from hoga.api.watchlist import save_document, load_document
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0, member_codes=["000660"])],
        entries=[
            WatchlistEntry(code="000660", name="SK", registered_at_kst_date="20260101", last_success_date=None),
            WatchlistEntry(code="005930", name="삼성", registered_at_kst_date="20260101", last_success_date=None),  # orphan
        ],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert {e.code for e in reloaded.entries} == {"000660"}


def test_load_document_does_not_prune_drift(tmp_path):
    """read 경로는 drift 를 보존한다(ADR-0065: read 에서 wipe 금지) — prune 은 write 전용."""
    from hoga.api.watchlist import load_document
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3,
        "folders": [{"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["000660"]}],
        "entries": [
            {"code": "000660", "name": "SK", "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101", "last_success_date": None},  # orphan
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert {e.code for e in doc.entries} == {"000660", "005930"}  # orphan 보존


async def test_invariant_holds_after_remove_member_last_folder(tmp_path):
    """mutation 이 member_codes 만 손대도, save 가 orphan 을 prune 해 불변식이 성립한다."""
    from hoga.api.watchlist import create_folder, add_member, remove_member, load_document
    f = await create_folder(tmp_path, name="스윙")
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260101", folder_id=f.id)
    await remove_member(tmp_path, code="005930", folder_id=f.id)
    doc = load_document(tmp_path)
    members = {c for fo in doc.folders for c in fo.member_codes}
    assert {e.code for e in doc.entries} == members == set()


@pytest.mark.parametrize("op", ["delete_folder", "remove_entry", "remove_entries"])
async def test_invariant_holds_after_mutation(tmp_path, op):
    """delete_folder / remove_entry / remove_entries 모두 entry 정리를 save 에 위임해도
    불변식 {e.code}==⋃member_codes 가 성립한다."""
    from hoga.api import watchlist as wl
    f1 = await wl.create_folder(tmp_path, name="스윙")
    f2 = await wl.create_folder(tmp_path, name="장기")
    await wl.add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260101", folder_id=f1.id)
    await wl.add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260101", folder_id=f2.id)
    await wl.add_member(tmp_path, code="000660", name="SK", today_kst_date="20260101", folder_id=f1.id)
    if op == "delete_folder":
        await wl.delete_folder(tmp_path, folder_id=f1.id)  # 000660 고아 → 탈락, 005930 잔류
    elif op == "remove_entry":
        await wl.remove_entry(tmp_path, code="005930")     # 두 폴더에서 다 빠짐
    else:
        await wl.remove_entries(tmp_path, codes=["005930", "000660"])
    doc = wl.load_document(tmp_path)
    members = {c for fo in doc.folders for c in fo.member_codes}
    assert {e.code for e in doc.entries} == members
