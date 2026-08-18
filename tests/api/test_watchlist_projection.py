"""Watchlist display projection rules live in one domain module."""
from __future__ import annotations

from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder, code_items
from hoga.api.watchlist_projection import (
    capture_ordered_codes,
    display_ordered_codes,
    first_membership_positions,
    project_entry_views,
)


def _doc():
    return WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000b",
                name="Second",
                order=1,
                items=code_items(["000660", "035720"]),
            ),
            WatchlistFolder(
                id="f_0000000a",
                name="First",
                order=0,
                items=code_items(["005930", "000660", "999999"]),
            ),
        ],
        entries=[
            WatchlistEntry(
                code="005930",
                name="Samsung",
                registered_at_kst_date="20260601",
                last_success_date="20260610",
            ),
            WatchlistEntry(
                code="000660",
                name="Hynix",
                registered_at_kst_date="20260601",
                last_success_date=None,
            ),
            WatchlistEntry(
                code="035720",
                name="Kakao",
                registered_at_kst_date="20260602",
                last_success_date=None,
            ),
        ],
    )


def test_display_ordered_codes_dedupes_by_first_membership():
    assert display_ordered_codes(_doc()) == ["005930", "000660", "035720"]


def test_project_entries_preserves_each_valid_membership_row():
    views = project_entry_views(_doc())

    assert [(v.folder_id, v.order, v.code) for v in views] == [
        ("f_0000000a", 0, "005930"),
        ("f_0000000a", 1, "000660"),
        ("f_0000000b", 0, "000660"),
        ("f_0000000b", 1, "035720"),
    ]
    assert views[0].name == "Samsung"
    assert views[0].last_success_date == "20260610"
    assert all(v.capture_candidate for v in views)


def test_project_entries_mark_every_row_as_capture_candidate():
    """게이트 제거(ADR-0150) 후 `capture_candidate` 는 전 행에서 true 다.

    상수가 된 이 필드의 정리는 `deriveStorageLabel` 이 이미 write-only 라는 발견과 함께
    별도로 다룬다(그 값이 **틀리지 않으므로** 급하지 않다).
    """
    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="첫 그룹",
                order=0,
                items=code_items(["005930", "000660"]),
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="둘째 그룹",
                order=1,
                items=code_items(["005930"]),
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
        ],
    )

    views = project_entry_views(doc)

    by_row = {(v.folder_id, v.code): v.capture_candidate for v in views}
    assert by_row == {
        ("f_0000000a", "005930"): True,
        ("f_0000000a", "000660"): True,   # 옛 계약이라면 False 였다(그 폴더가 꺼져 있었으므로)
        ("f_0000000b", "005930"): True,
    }


def test_first_membership_positions_returns_topmost_valid_position():
    assert first_membership_positions(_doc()) == {
        "005930": ("f_0000000a", 0),
        "000660": ("f_0000000a", 1),
        "035720": ("f_0000000b", 1),
    }


def test_capture_ordered_codes_includes_every_folder() -> None:
    """폴더 단위 저장 옵트인은 ADR-0150 으로 제거됐다 — **모든 폴더의 멤버가 후보**다.

    옛 계약("capture_enabled 폴더만")을 뒤집어 못박는다. 그냥 지우면 새 계약을 아무도
    지키지 않는다. dedup·문서 순서·known_codes 필터는 그대로다.
    """
    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Enabled",
                order=0,
                items=code_items(["005930", "000660"]),
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Disabled",
                order=1,
                items=code_items(["035720"]),
            ),
            WatchlistFolder(
                id="f_0000000c",
                name="AlsoEnabled",
                order=2,
                items=code_items(["000660", "035420"]),
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035420", name="NAVER", registered_at_kst_date="20260601"),
        ],
    )

    # 가운데 폴더(옛 "Disabled")의 035720 도 이제 포함된다 — 문서 순서 · 코드 dedup 유지.
    assert capture_ordered_codes(doc) == ["005930", "000660", "035720", "035420"]
    assert capture_ordered_codes(doc, known_codes={"005930", "035420"}) == ["005930", "035420"]
