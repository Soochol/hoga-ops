"""v3→v4 마이그레이션: `member_codes` → `items` 유니온(코드 + 메모 "빈칸").

v4 는 폴더가 소유하는 리스트를 코드 전용에서 항목 유니온으로 승격한다. 여기서 재는 것:

1. v3 파일이 items(전부 code kind)로 **무손실** 승격되는가
2. 메모가 든 v4 파일이 라운드트립에서 **순서까지** 보존되는가
3. 알 수 없는 `kind` 가 **corruption 경로**(backup + empty)로 가는가 — 읽기 시점에
   조용히 드롭하면 다음 save 가 그 드롭을 영속시켜 read-path wipe 가 된다(ADR-0065)
4. 메모가 불변식({e.code} == ⋃ code items) **밖**에 있는가 — 메모만 남은 폴더가
   entry 를 살려 두지 않고, 메모 삭제가 entry 를 죽이지도 않는다
"""
from __future__ import annotations

import json

import pytest

from hoga.api.models import (
    WatchlistCodeItem,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistMemoItem,
)
from hoga.api.watchlist import load_document, save_document


def _entry(code: str, name: str = "x") -> WatchlistEntry:
    return WatchlistEntry(code=code, name=name, registered_at_kst_date="20260101")


def test_migrate_v3_member_codes_become_code_items(tmp_path):
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "schema_version": 3,
        "folders": [{"id": "f_0000000a", "name": "스윙", "order": 0,
                     "member_codes": ["005930", "000660"], "capture_enabled": True}],
        "entries": [
            {"code": "005930", "name": "삼성", "registered_at_kst_date": "20260101",
             "last_success_date": None},
            {"code": "000660", "name": "SK", "registered_at_kst_date": "20260101",
             "last_success_date": None},
        ],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.schema_version == 4
    items = doc.folders[0].items
    assert all(isinstance(i, WatchlistCodeItem) for i in items)
    assert doc.folders[0].code_members() == ["005930", "000660"]  # 순서 보존


def test_memo_survives_round_trip_at_its_position(tmp_path):
    doc = WatchlistDocument(
        folders=[WatchlistFolder(
            id="f_0000000a", name="스윙", order=0,
            items=[WatchlistCodeItem(code="005930"),
                   WatchlistMemoItem(id="m_00000001", text="실적 발표 대기"),
                   WatchlistCodeItem(code="000660")],
        )],
        entries=[_entry("005930"), _entry("000660")],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    kinds = [(type(i).__name__, getattr(i, "code", None) or i.text)
             for i in reloaded.folders[0].items]
    assert kinds == [
        ("WatchlistCodeItem", "005930"),
        ("WatchlistMemoItem", "실적 발표 대기"),
        ("WatchlistCodeItem", "000660"),
    ]


def test_blank_memo_is_a_valid_state(tmp_path):
    """`text=""` 는 빈 줄이다 — 폴더 이름과 정반대로, blank 를 거절하면 안 된다."""
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0,
                                 items=[WatchlistMemoItem(id="m_00000001", text="")])],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert reloaded.folders[0].items[0].text == ""


def test_unknown_item_kind_is_corruption_not_a_silent_drop(tmp_path):
    """읽기 경로에서 드롭하면 다음 save 가 그 드롭을 영속시킨다(ADR-0065 위반).

    그래서 미지의 kind 는 discriminated union 에서 ValidationError 가 되고,
    load_document 의 corruption 경로가 원본을 **백업**한 뒤 빈 문서를 준다.
    """
    p = tmp_path / "watchlist.json"
    p.write_text(json.dumps({
        "schema_version": 4,
        "folders": [{"id": "f_0000000a", "name": "A", "order": 0,
                     "items": [{"kind": "divider", "id": "d_1"}]}],
        "entries": [],
    }), encoding="utf-8")
    doc = load_document(tmp_path)
    assert doc.folders == []                                   # 빈 문서
    backups = list(tmp_path.glob("watchlist.json.corrupt-*"))
    assert len(backups) == 1, "원본이 백업되지 않으면 조용한 유실이다"
    assert "divider" in backups[0].read_text(encoding="utf-8")  # 원본 그대로


def test_memo_only_folder_does_not_keep_entries_alive(tmp_path):
    """메모는 불변식 밖 — 코드 멤버가 없으면 entry 는 orphan 으로 prune 된다."""
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0,
                                 items=[WatchlistMemoItem(id="m_00000001", text="메모만")])],
        entries=[_entry("005930")],
    )
    save_document(tmp_path, doc)
    assert load_document(tmp_path).entries == []


def test_duplicate_memo_ids_are_deduped_across_folders(tmp_path):
    """PATCH/DELETE `/memos/{id}` 가 folder 를 안 받으므로 id 는 문서 전역 유니크여야
    한다 — 중복이 남으면 첫 번째만 고쳐지고 나머지는 조용히 어긋난다."""
    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(id="f_0000000a", name="A", order=0,
                            items=[WatchlistMemoItem(id="m_00000001", text="첫째")]),
            WatchlistFolder(id="f_0000000b", name="B", order=1,
                            items=[WatchlistMemoItem(id="m_00000001", text="둘째")]),
        ],
    )
    save_document(tmp_path, doc)
    reloaded = load_document(tmp_path)
    assert [i.text for i in reloaded.folders[0].items] == ["첫째"]
    assert reloaded.folders[1].items == []  # 나중 등장이 드롭


def test_v3_key_on_the_v4_model_is_not_silently_accepted(tmp_path):
    """v3 의 `member_codes=` 를 v4 생성자에 넘기면 pydantic 이 **조용히 무시**한다.

    이 테스트는 그 침묵을 문서화한다 — 그래서 `member_codes` 라는 이름을 property 로
    남기지 않고 완전히 지웠다. 남겨 뒀다면 기존
    `model_copy(update={"member_codes": ...})` 호출부가 에러 없이 무시됐을 것이다.
    """
    f = WatchlistFolder(id="f_0000000a", name="A", order=0, member_codes=["005930"])
    assert f.items == []            # 삼켜졌다
    assert f.code_members() == []
    assert not hasattr(f, "member_codes")


def test_reorder_entries_keeps_memo_pinned_to_its_index(tmp_path):
    """`ordered_codes` 계약(v3 유래)은 코드 슬롯에만 새 순서를 채운다 — 메모는 제자리."""
    import asyncio

    from hoga.api.watchlist import reorder_entries

    doc = WatchlistDocument(
        folders=[WatchlistFolder(
            id="f_0000000a", name="A", order=0,
            items=[WatchlistCodeItem(code="005930"),
                   WatchlistMemoItem(id="m_00000001", text="구분"),
                   WatchlistCodeItem(code="000660")],
        )],
        entries=[_entry("005930"), _entry("000660")],
    )
    save_document(tmp_path, doc)
    asyncio.run(reorder_entries(tmp_path, folder_id="f_0000000a",
                                ordered_codes=["000660", "005930"]))
    items = load_document(tmp_path).folders[0].items
    assert [getattr(i, "code", None) or i.text for i in items] == ["000660", "구분", "005930"]


def test_reorder_entries_set_must_match_code_members_only(tmp_path):
    """집합 일치 검사는 **코드만** 센다 — 메모 id 를 섞어 보내면 409(mismatch)."""
    import asyncio

    from hoga.api.watchlist import WatchlistSetMismatchError, reorder_entries

    doc = WatchlistDocument(
        folders=[WatchlistFolder(
            id="f_0000000a", name="A", order=0,
            items=[WatchlistCodeItem(code="005930"),
                   WatchlistMemoItem(id="m_00000001", text="구분")],
        )],
        entries=[_entry("005930")],
    )
    save_document(tmp_path, doc)
    with pytest.raises(WatchlistSetMismatchError):
        asyncio.run(reorder_entries(tmp_path, folder_id="f_0000000a",
                                    ordered_codes=["005930", "m_00000001"]))
