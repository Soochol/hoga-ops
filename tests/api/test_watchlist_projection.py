"""Watchlist display projection rules live in one domain module."""
from __future__ import annotations


def _doc():
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder

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
    from hoga.api.watchlist_projection import display_ordered_codes

    assert display_ordered_codes(_doc()) == ["005930", "000660", "035720"]


def test_project_entries_preserves_each_valid_membership_row():
    from hoga.api.watchlist_projection import project_entry_views

    views = project_entry_views(_doc())

    assert [(v.folder_id, v.order, v.code) for v in views] == [
        ("f_0000000a", 0, "005930"),
        ("f_0000000a", 1, "000660"),
        ("f_0000000b", 0, "000660"),
        ("f_0000000b", 1, "035720"),
    ]
    assert views[0].name == "Samsung"
    assert views[0].last_success_date == "20260610"


def test_first_membership_positions_returns_topmost_valid_position():
    from hoga.api.watchlist_projection import first_membership_positions

    assert first_membership_positions(_doc()) == {
        "005930": ("f_0000000a", 0),
        "000660": ("f_0000000a", 1),
        "035720": ("f_0000000b", 1),
    }
