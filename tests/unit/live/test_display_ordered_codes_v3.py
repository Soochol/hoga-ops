"""다중 소속 평탄화(v4): 폴더 order순 → items 의 code 항목순, 첫 등장으로 dedup."""
from __future__ import annotations


def _doc(folders, entries_codes):
    """(id, name, order, codes) 튜플 목록 → 문서. `codes` 는 code item 으로 승격된다."""
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder, code_items
    return WatchlistDocument(
        folders=[WatchlistFolder(id=fid, name=name, order=order, items=code_items(codes))
                 for fid, name, order, codes in folders],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101",
                                last_success_date=None) for c in entries_codes],
    )


def test_flatten_dedup_topmost_folder_wins():
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = _doc(
        folders=[
            ("f_0000000a", "A", 0, ["005930", "000660"]),
            ("f_0000000b", "B", 1, ["000660", "035720"]),
        ],
        entries_codes=["005930", "000660", "035720"],
    )
    # A: 005930,000660 ; B: 000660(중복,skip),035720 → 005930,000660,035720
    assert display_ordered_codes(doc) == ["005930", "000660", "035720"]


def test_folders_sorted_by_order():
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = _doc(
        folders=[
            ("f_0000000b", "B", 1, ["035720"]),
            ("f_0000000a", "A", 0, ["005930"]),
        ],
        entries_codes=["005930", "035720"],
    )
    assert display_ordered_codes(doc) == ["005930", "035720"]


def test_empty_folders_yield_empty():
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = _doc(folders=[("f_0000000a", "A", 0, [])], entries_codes=[])
    assert display_ordered_codes(doc) == []


def test_memo_items_never_reach_display_order():
    """메모는 Code 가 아니므로 Live Set 산출(=KIS WS 구독 경계)에 등장하면 안 된다.

    `display_ordered_codes` 가 items 를 그대로 흘리면 메모 id 가 코드로 둔갑해
    구독 요청에 섞인다 — 이 테스트가 그 경로를 막는다.
    """
    from hoga.api.models import (
        WatchlistCodeItem,
        WatchlistDocument,
        WatchlistEntry,
        WatchlistFolder,
        WatchlistMemoItem,
    )
    from hoga.api.watchlist_projection import display_ordered_codes
    doc = WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="A", order=0, items=[
            WatchlistCodeItem(code="005930"),
            WatchlistMemoItem(id="m_0000000a", text="실적 발표 대기"),
            WatchlistCodeItem(code="000660"),
        ])],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101")
                 for c in ("005930", "000660")],
    )
    assert display_ordered_codes(doc) == ["005930", "000660"]


def test_compute_capture_candidates_uses_enabled_folders(tmp_path, monkeypatch) -> None:
    from hoga.api.models import WatchlistDocument, WatchlistEntry, WatchlistFolder, code_items
    from hoga.api.watchlist import save_document
    from hoga.live.coverage import _compute_capture_candidates

    save_document(tmp_path, WatchlistDocument(
        folders=[
            WatchlistFolder(
                id="f_0000000a",
                name="Enabled",
                order=0,
                items=code_items(["005930", "000660"]),
                capture_enabled=True,
            ),
            WatchlistFolder(
                id="f_0000000b",
                name="Disabled",
                order=1,
                items=code_items(["035720"]),
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
