"""Watchlist display projection rules live in one domain module."""
from __future__ import annotations

from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
from hoga.api.watchlist_projection import (
    capture_ordered_codes,
    display_ordered_codes,
    first_membership_positions,
    project_entry_views,
    project_folder_views,
)


def _doc():
    return WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000b",
                name="Second",
                order=1,
                member_codes=["000660", "035720"],
            ),
            WatchlistFolder(
                id="f_0000000a",
                name="First",
                order=0,
                member_codes=["005930", "000660", "999999"],
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


def test_project_folder_views_includes_capture_enabled() -> None:
    views = project_folder_views(_doc())

    assert views[0].capture_enabled is True


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


def test_project_entries_marks_capture_candidate_by_any_enabled_membership():
    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Disabled",
                order=0,
                member_codes=["005930", "000660"],
                capture_enabled=False,
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Enabled",
                order=1,
                member_codes=["005930"],
                capture_enabled=True,
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
        ("f_0000000a", "000660"): False,
        ("f_0000000b", "005930"): True,
    }


def test_first_membership_positions_returns_topmost_valid_position():
    assert first_membership_positions(_doc()) == {
        "005930": ("f_0000000a", 0),
        "000660": ("f_0000000a", 1),
        "035720": ("f_0000000b", 1),
    }


def test_capture_ordered_codes_uses_enabled_folders_only() -> None:
    doc = WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Enabled",
                order=0,
                member_codes=["005930", "000660"],
                capture_enabled=True,
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Disabled",
                order=1,
                member_codes=["035720"],
                capture_enabled=False,
            ),
            WatchlistFolder(
                id="f_0000000c",
                name="AlsoEnabled",
                order=2,
                member_codes=["000660", "035420"],
                capture_enabled=True,
            ),
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035420", name="NAVER", registered_at_kst_date="20260601"),
        ],
    )

    assert capture_ordered_codes(doc) == ["005930", "000660", "035420"]
    assert capture_ordered_codes(doc, known_codes={"005930", "035420"}) == ["005930", "035420"]
