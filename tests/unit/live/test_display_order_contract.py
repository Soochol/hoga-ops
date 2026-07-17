"""표시 순서 계약(ADR-0070, deepening 2): 백엔드 display_ordered_codes 가 공유 골든
픽스처와 일치. 픽스처는 프론트가 JSON import 하도록 frontend 트리에 두고, 백엔드는
그 파일을 읽는다 — 한 파일이 양쪽 계약의 단일 진실(frontend/src/watchlist/
displayOrderContract.test.ts 도 같은 파일을 검증). 한쪽 정렬 규칙만 바뀌어도 한쪽
테스트가 깨지므로, 화면 상단과 실제 KIS WS 구독 집합(Live Set)의 desync 를 자동
포착한다(capture-critical)."""
from __future__ import annotations
import json
from pathlib import Path

_FIXTURE = (Path(__file__).resolve().parents[3]
            / "frontend" / "src" / "watchlist" / "__fixtures__" / "watchlistDisplayOrder.json")


def test_display_ordered_codes_matches_golden_fixture():
    from hoga.api.models import WatchlistDocument, WatchlistFolder, WatchlistEntry
    from hoga.api.watchlist_projection import display_ordered_codes
    fx = json.loads(_FIXTURE.read_text(encoding="utf-8"))
    doc = WatchlistDocument(
        folders=[WatchlistFolder(**f) for f in fx["folders"]],
        entries=[WatchlistEntry(**e) for e in fx["entries"]],
    )
    assert display_ordered_codes(doc) == fx["display_order"]
