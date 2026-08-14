"""메모("빈칸") 항목이 캡처/구독 경로에 새지 않는지 — v4 의 최대 리스크 가드.

v4 는 폴더가 소유하는 리스트를 코드 전용(`member_codes`)에서 항목 유니온(`items`)으로
승격했다. 그 리스트를 읽는 projection 세 함수는 **캡처 플래너 · Live Set · 히트맵
시드**로 흘러간다:

| 함수 | 소비자 |
|---|---|
| `capture_ordered_codes`      | `hoga/live/coverage.py` (캡처 후보 산출) |
| `display_ordered_codes`      | 표시 순서 계약(프론트 골든 픽스처와 공유) |
| `first_membership_positions` | `hoga/api/heatmap.py` (히트맵 일회 시드 배치) |

세 함수가 전부 `WatchlistFolder.code_members()` 를 통과하므로 메모는 못 샌다.

**이 가드가 실제로 막는 방향 (red-check 으로 확인한 것):**

`code_members()` 를 `folder.items` 직접 순회로 되돌리는 회귀를 주입해 봤더니
**세 함수의 반환값은 그대로였다.** 이미 drift 필터(`if code not in by_code:
continue`)가 있어서 메모 id 는 entry 가 없는 멤버로 걸러지기 때문이다. 즉 값 경로는
**이중 방어**이고, 1차(code_members)가 무너져도 2차(drift 필터)가 값을 지킨다 —
대신 종목마다 warning 이 쏟아진다.

값이 실제로 어긋나는 곳은 **drift 필터가 없는 `order` 축**이다. `project_entry_views`
의 enumerate 를 v3 방식(코드만 센 조밀 인덱스)으로 되돌리면
`test_entry_and_memo_orders_share_one_dense_axis` 가 `[0,0,1,2,4] != [0,1,2,3,4]` 로
깨진다(실측). 그 테스트가 이 파일의 날 선 부분이고, 나머지는 구조를 값으로 고정해
회귀 시 로그 폭증을 잡는 역할이다.

**이 가드가 못 보는 것**: 프론트가 order 를 정렬 키가 아닌 배열 인덱스로 쓰기
시작하는 변경. 그건 프론트 테스트의 몫이다.

**새는 것이 왜 위험한가**: 메모 id(`m_…`)가 코드로 둔갑해 캡처 큐/WS 구독 요청에
섞이면, 벤더는 알 수 없는 종목으로 응답하거나 조용히 무시한다. 어느 쪽이든 증상은
"관심종목 하나가 수집되지 않는다" 로 한참 뒤에 나타난다.
"""
from __future__ import annotations

from hoga.api.models import (
    WatchlistCodeItem,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistMemoItem,
)
from hoga.api.watchlist_projection import (
    capture_ordered_codes,
    display_ordered_codes,
    first_membership_positions,
    project_entry_views,
    project_memo_views,
)

_MEMO_ID = "m_0000000a"


def _doc_with_memos() -> WatchlistDocument:
    """메모를 **코드 사이에** 끼운 문서 — 앞/중간/뒤 셋 다 덮는다."""
    return WatchlistDocument(
        folders=[
            WatchlistFolder(id="f_0000000a", name="스윙", order=0, capture_enabled=True, items=[
                WatchlistMemoItem(id=_MEMO_ID, text="선두 메모"),
                WatchlistCodeItem(code="005930"),
                WatchlistMemoItem(id="m_0000000b", text=""),          # 빈 줄
                WatchlistCodeItem(code="000660"),
                WatchlistMemoItem(id="m_0000000c", text="끝 메모"),
            ]),
            WatchlistFolder(id="f_0000000b", name="관망", order=1, capture_enabled=False, items=[
                WatchlistMemoItem(id="m_0000000d", text="수집 끔"),
                WatchlistCodeItem(code="035720"),
            ]),
        ],
        entries=[
            WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101")
            for c in ("005930", "000660", "035720")
        ],
    )


def test_capture_ordered_codes_contains_only_codes() -> None:
    assert capture_ordered_codes(_doc_with_memos()) == ["005930", "000660"]


def test_display_ordered_codes_contains_only_codes() -> None:
    assert display_ordered_codes(_doc_with_memos()) == ["005930", "000660", "035720"]


def test_first_membership_positions_uses_a_code_only_dense_index() -> None:
    """히트맵 좌표계는 메모를 모른다 — 인덱스에 빈자리가 생기면 안 된다.

    ⚠ 이 `order` 는 `project_entry_views` 의 것과 **다른 축**이다(그쪽은 items
    인덱스). 두 축을 통일하려 들면 히트맵 시드에 유령 칸이 생긴다.
    """
    positions = first_membership_positions(_doc_with_memos())
    assert positions == {
        "005930": ("f_0000000a", 0),   # items 로는 1번이지만 코드로는 0번
        "000660": ("f_0000000a", 1),   # items 로는 3번
        "035720": ("f_0000000b", 0),   # items 로는 1번
    }


def test_no_memo_id_appears_anywhere_in_the_code_projections() -> None:
    """id 문자열 자체를 훑는다 — 위 세 단언이 리스트 모양만 보는 것을 보완한다."""
    doc = _doc_with_memos()
    memo_ids = {i.id for f in doc.folders for i in f.items if isinstance(i, WatchlistMemoItem)}
    leaked = memo_ids & (
        set(capture_ordered_codes(doc))
        | set(display_ordered_codes(doc))
        | set(first_membership_positions(doc))
        | {v.code for v in project_entry_views(doc)}
    )
    assert leaked == set(), f"메모 id 가 코드 경로로 샜다: {leaked}"


def test_entry_and_memo_orders_share_one_dense_axis() -> None:
    """`entries ∪ memos` 는 폴더당 0..N-1 로 조밀하다 — 프론트 병합의 전제.

    이게 깨지면 프론트가 order 로 정렬했을 때 행이 겹치거나 빈다.
    """
    doc = _doc_with_memos()
    entries = project_entry_views(doc)
    memos = project_memo_views(doc)
    for folder in doc.folders:
        orders = sorted(
            [e.order for e in entries if e.folder_id == folder.id]
            + [m.order for m in memos if m.folder_id == folder.id]
        )
        assert orders == list(range(len(folder.items))), f"folder {folder.id} 축이 어긋났다"


def test_memo_text_is_shipped_verbatim_including_blank() -> None:
    memos = {m.id: m.text for m in project_memo_views(_doc_with_memos())}
    assert memos[_MEMO_ID] == "선두 메모"
    assert memos["m_0000000b"] == ""    # 빈 줄이 살아서 나간다
