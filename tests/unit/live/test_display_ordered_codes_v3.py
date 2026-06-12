"""다중 소속 평탄화(v3): 폴더 order순 → member_codes순, 첫 등장으로 dedup."""
from __future__ import annotations


def _doc(folders, entries_codes):
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    return WatchlistDocument(
        folders=[WatchlistFolder(**f) for f in folders],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101",
                                last_success_date=None) for c in entries_codes],
    )


def test_flatten_dedup_topmost_folder_wins():
    from hoga.live.live_session import display_ordered_codes
    doc = _doc(
        folders=[
            {"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["005930", "000660"]},
            {"id": "f_0000000b", "name": "B", "order": 1, "member_codes": ["000660", "035720"]},
        ],
        entries_codes=["005930", "000660", "035720"],
    )
    # A: 005930,000660 ; B: 000660(중복,skip),035720 → 005930,000660,035720
    assert display_ordered_codes(doc) == ["005930", "000660", "035720"]


def test_folders_sorted_by_order():
    from hoga.live.live_session import display_ordered_codes
    doc = _doc(
        folders=[
            {"id": "f_0000000b", "name": "B", "order": 1, "member_codes": ["035720"]},
            {"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["005930"]},
        ],
        entries_codes=["005930", "035720"],
    )
    assert display_ordered_codes(doc) == ["005930", "035720"]


def test_empty_folders_yield_empty():
    from hoga.live.live_session import display_ordered_codes
    doc = _doc(folders=[{"id": "f_0000000a", "name": "A", "order": 0, "member_codes": []}],
               entries_codes=[])
    assert display_ordered_codes(doc) == []
