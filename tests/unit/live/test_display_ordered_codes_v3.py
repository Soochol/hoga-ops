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
    from hoga.api.watchlist_projection import display_ordered_codes
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
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = _doc(
        folders=[
            {"id": "f_0000000b", "name": "B", "order": 1, "member_codes": ["035720"]},
            {"id": "f_0000000a", "name": "A", "order": 0, "member_codes": ["005930"]},
        ],
        entries_codes=["005930", "035720"],
    )
    assert display_ordered_codes(doc) == ["005930", "035720"]


def test_empty_folders_yield_empty():
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = _doc(folders=[{"id": "f_0000000a", "name": "A", "order": 0, "member_codes": []}],
               entries_codes=[])
    assert display_ordered_codes(doc) == []


def test_compute_capture_candidates_uses_enabled_folders(tmp_path, monkeypatch) -> None:
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder
    from hoga.api.watchlist import save_document
    from hoga.live.coverage import _compute_capture_candidates

    save_document(tmp_path, WatchlistDocument(
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
        ],
        entries=[
            WatchlistEntry(code="005930", name="삼성전자", registered_at_kst_date="20260601"),
            WatchlistEntry(code="000660", name="SK하이닉스", registered_at_kst_date="20260601"),
            WatchlistEntry(code="035720", name="카카오", registered_at_kst_date="20260601"),
        ],
    ))

    class Hit:
        def __init__(self, code):
            self.code = code

    monkeypatch.setattr(
        "hoga.api.symbols.search",
        lambda _query, limit=10_000: [Hit("005930"), Hit("035720")],
    )

    assert _compute_capture_candidates(tmp_path) == ["005930"]
