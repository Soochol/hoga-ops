"""멤버십 1급 ops(v3): add_member(생성·시드), remove_member(마지막 폴더→entry 삭제)."""
from __future__ import annotations
import pytest


async def _seed_folder(tmp_path, name="스윙"):
    from hoga.api.watchlist import create_folder
    f = await create_folder(tmp_path, name=name)
    return f.id


async def test_add_member_creates_entry_and_membership(tmp_path):
    from hoga.api.watchlist import add_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]
    assert next(f for f in doc.folders if f.id == fid).member_codes == ["005930"]


async def test_add_member_second_folder_keeps_single_entry(tmp_path):
    from hoga.api.watchlist import add_member, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 단일 entry
    assert next(f for f in doc.folders if f.id == f1).member_codes == ["005930"]
    assert next(f for f in doc.folders if f.id == f2).member_codes == ["005930"]


async def test_add_member_idempotent(tmp_path):
    from hoga.api.watchlist import add_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    doc = load_document(tmp_path)
    assert next(f for f in doc.folders if f.id == fid).member_codes == ["005930"]  # 중복 없음


async def test_remove_member_last_folder_drops_entry(tmp_path):
    from hoga.api.watchlist import add_member, remove_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await remove_member(tmp_path, code="005930", folder_id=fid)
    doc = load_document(tmp_path)
    assert doc.entries == []  # 마지막 폴더 제거 → watchlist 탈락
    assert next(f for f in doc.folders if f.id == fid).member_codes == []


async def test_remove_member_other_folder_keeps_entry(tmp_path):
    from hoga.api.watchlist import add_member, remove_member, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    await remove_member(tmp_path, code="005930", folder_id=f1)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 잔여 폴더로 유지
    assert next(f for f in doc.folders if f.id == f2).member_codes == ["005930"]


async def test_add_member_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import add_member, FolderNotFoundError
    with pytest.raises(FolderNotFoundError):
        await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id="f_deadbeef")


async def test_delete_folder_orphans_dropped_keeps_shared(tmp_path):
    from hoga.api.watchlist import add_member, delete_folder, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    await add_member(tmp_path, code="000660", name="SK", today_kst_date="20260611", folder_id=f1)
    await delete_folder(tmp_path, folder_id=f1)
    doc = load_document(tmp_path)
    # 005930 survives (also in f2); 000660 orphaned → dropped
    assert [e.code for e in doc.entries] == ["005930"]
    assert [f.id for f in doc.folders] == [f2]


async def test_reorder_entries_reorders_member_codes(tmp_path):
    from hoga.api.watchlist import add_member, reorder_entries, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await add_member(tmp_path, code="000660", name="SK", today_kst_date="20260611", folder_id=fid)
    await reorder_entries(tmp_path, folder_id=fid, ordered_codes=["000660", "005930"])
    doc = load_document(tmp_path)
    assert next(f for f in doc.folders if f.id == fid).member_codes == ["000660", "005930"]
