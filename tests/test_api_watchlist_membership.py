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
    assert next(f for f in doc.folders if f.id == fid).code_members() == ["005930"]


async def test_add_member_second_folder_keeps_single_entry(tmp_path):
    from hoga.api.watchlist import add_member, create_folder, load_document
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 단일 entry
    assert next(f for f in doc.folders if f.id == f1).code_members() == ["005930"]
    assert next(f for f in doc.folders if f.id == f2).code_members() == ["005930"]


async def test_add_member_idempotent(tmp_path):
    from hoga.api.watchlist import add_member, load_document
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    doc = load_document(tmp_path)
    assert next(f for f in doc.folders if f.id == fid).code_members() == ["005930"]  # 중복 없음


async def test_remove_member_last_folder_drops_entry(tmp_path):
    from hoga.api.watchlist import add_member, load_document, remove_member
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await remove_member(tmp_path, code="005930", folder_id=fid)
    doc = load_document(tmp_path)
    assert doc.entries == []  # 마지막 폴더 제거 → watchlist 탈락
    assert next(f for f in doc.folders if f.id == fid).code_members() == []


async def test_remove_member_other_folder_keeps_entry(tmp_path):
    from hoga.api.watchlist import add_member, create_folder, load_document, remove_member
    f1 = await _seed_folder(tmp_path, name="스윙")
    f2 = (await create_folder(tmp_path, name="장기")).id
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f1)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=f2)
    await remove_member(tmp_path, code="005930", folder_id=f1)
    doc = load_document(tmp_path)
    assert [e.code for e in doc.entries] == ["005930"]  # 잔여 폴더로 유지
    assert next(f for f in doc.folders if f.id == f2).code_members() == ["005930"]


async def test_add_member_unknown_folder_raises(tmp_path):
    from hoga.api.watchlist import FolderNotFoundError, add_member
    with pytest.raises(FolderNotFoundError):
        await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id="f_deadbeef")


async def test_delete_folder_orphans_dropped_keeps_shared(tmp_path):
    from hoga.api.watchlist import add_member, create_folder, delete_folder, load_document
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
    from hoga.api.watchlist import add_member, load_document, reorder_entries
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    await add_member(tmp_path, code="000660", name="SK", today_kst_date="20260611", folder_id=fid)
    await reorder_entries(tmp_path, folder_id=fid, ordered_codes=["000660", "005930"])
    doc = load_document(tmp_path)
    assert next(f for f in doc.folders if f.id == fid).code_members() == ["000660", "005930"]


# --- at: items 인덱스 삽입 (패널 우클릭 "위에 종목 추가") -------------------
# add_memo 와 **같은 축**이라 코드만 보면 안 된다 — 삽입이 메모 자리를 함께 밀어야
# 표시 순서가 보존된다. 아래 셋은 그 축을 코드·메모가 섞인 폴더에서 잰다.


async def _seed_mixed(tmp_path):
    """items = [code 005930, memo, code 000660] 인 폴더 하나."""
    from hoga.api.watchlist import add_member, add_memo
    fid = await _seed_folder(tmp_path)
    await add_member(tmp_path, code="005930", name="삼성", today_kst_date="20260611", folder_id=fid)
    memo, _ = await add_memo(tmp_path, folder_id=fid, text="메모")
    await add_member(tmp_path, code="000660", name="SK", today_kst_date="20260611", folder_id=fid)
    return fid, memo.id


def _item_keys(doc, fid):
    """폴더 items 를 표시 순서 그대로 ('c:코드' | 'm:id') 로 — 두 종류를 한 줄에 세운다."""
    from hoga.api.models import WatchlistMemoItem
    folder = next(f for f in doc.folders if f.id == fid)
    return [f"m:{i.id}" if isinstance(i, WatchlistMemoItem) else f"c:{i.code}" for i in folder.items]


async def test_add_member_at_inserts_and_pushes_memos_down(tmp_path):
    """at=1 은 메모 **앞**에 들어가고 메모·뒤 코드가 한 칸씩 밀린다.

    코드만 재배열하고 메모를 놔두면 여기서 순서가 갈린다 — 그게 items 단일 축의 함정.
    """
    from hoga.api.watchlist import add_member, load_document
    fid, mid = await _seed_mixed(tmp_path)
    await add_member(tmp_path, code="035420", name="네이버", today_kst_date="20260611",
                     folder_id=fid, at=1)
    assert _item_keys(load_document(tmp_path), fid) == [
        "c:005930", "c:035420", f"m:{mid}", "c:000660"]


async def test_add_member_at_beyond_length_clamps_to_end(tmp_path):
    """범위 초과는 422 가 아니라 끝으로 클램프 — 동시 편집으로 길이가 줄었을 뿐이다."""
    from hoga.api.watchlist import add_member, load_document
    fid, mid = await _seed_mixed(tmp_path)
    await add_member(tmp_path, code="035420", name="네이버", today_kst_date="20260611",
                     folder_id=fid, at=99)
    assert _item_keys(load_document(tmp_path), fid) == [
        "c:005930", f"m:{mid}", "c:000660", "c:035420"]


async def test_add_member_at_is_ignored_for_existing_member(tmp_path):
    """이미 멤버면 at 이 와도 자리를 옮기지 않는다 — add 는 멱등이고 이동은 reorder 의 몫."""
    from hoga.api.watchlist import add_member, load_document
    fid, mid = await _seed_mixed(tmp_path)
    await add_member(tmp_path, code="000660", name="SK", today_kst_date="20260611",
                     folder_id=fid, at=0)
    assert _item_keys(load_document(tmp_path), fid) == ["c:005930", f"m:{mid}", "c:000660"]
