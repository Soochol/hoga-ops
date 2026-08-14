"""`PUT /folders/{id}/items/order` — 표시 순서 전체(코드+메모) 재배열 (v4).

이 라우트는 기존 `PUT /reorder`(ordered_codes)와 **공존**한다. 계약을 하나로 합치지
않은 이유는 두 표면의 요구가 다르기 때문이다:

| 표면 | 메모를 보는가 | 메모 순서에 의견이 있는가 |
|---|---|---|
| 패널 dnd | 본다(드래그 대상) | **있다** — 표시 순서 전체를 정한다 |
| 편집 모달 | 안 본다 | **없다** — 코드만 재배열한다 |

의견 없는 표면에 전체 순서를 강요하면 사용자가 못 본 것을 대신 결정하게 되고, 어떻게
정하든(끝으로 밀기 / 제자리 고정) 조용한 이동이 된다. 그래서 편집 모달은 "메모는
제자리" 계약을 그대로 쓴다 — 그쪽 동작은 test_api_watchlist_migrate_v4.py 가 잰다.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import (
    WatchlistCodeItem,
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    WatchlistMemoItem,
)
from hoga.api.watchlist import load_document, save_document

FID = "f_0000000a"
ORDER_URL = f"/api/watchlist/folders/{FID}/items/order"


def _app(tmp_path: Path) -> FastAPI:
    from hoga.api.watchlist_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


@pytest.fixture
def seeded(tmp_path: Path) -> Path:
    """items: [005930(0), memo(1), 000660(2)] — 메모가 종목 사이에 있다."""
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id=FID, name="스윙", order=0, items=[
            WatchlistCodeItem(code="005930"),
            WatchlistMemoItem(id="m_0000000a", text="실적 발표 대기"),
            WatchlistCodeItem(code="000660"),
        ])],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101")
                 for c in ("005930", "000660")],
    ))
    return tmp_path


def _keys(data_dir: Path) -> list[str]:
    return [getattr(i, "code", None) or i.id for i in load_document(data_dir).folders[0].items]


def test_reorders_codes_and_memos_together(seeded: Path) -> None:
    with TestClient(_app(seeded)) as c:
        r = c.put(ORDER_URL, json={"ordered_items": [
            {"kind": "memo", "id": "m_0000000a"},
            {"kind": "code", "code": "000660"},
            {"kind": "code", "code": "005930"},
        ]})
        assert r.status_code == 204, r.text
    assert _keys(seeded) == ["m_0000000a", "000660", "005930"]


def test_memo_text_survives_reorder(seeded: Path) -> None:
    """요청은 id 만 싣는다 — 재배열이 내용을 옮기지 않는데도 텍스트가 살아야 한다."""
    with TestClient(_app(seeded)) as c:
        c.put(ORDER_URL, json={"ordered_items": [
            {"kind": "memo", "id": "m_0000000a"},
            {"kind": "code", "code": "005930"},
            {"kind": "code", "code": "000660"},
        ]})
        memos = c.get("/api/watchlist").json()["memos"]
    assert memos[0]["text"] == "실적 발표 대기"
    assert memos[0]["order"] == 0


def test_partial_list_is_409_not_a_silent_truncation(seeded: Path) -> None:
    """집합 일치를 강제한다 — 빠뜨린 항목이 조용히 사라지면 데이터 유실이다."""
    with TestClient(_app(seeded)) as c:
        r = c.put(ORDER_URL, json={"ordered_items": [{"kind": "code", "code": "005930"}]})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "reorder_set_mismatch"
    assert _keys(seeded) == ["005930", "m_0000000a", "000660"]  # 원본 그대로


def test_unknown_memo_id_is_409(seeded: Path) -> None:
    with TestClient(_app(seeded)) as c:
        r = c.put(ORDER_URL, json={"ordered_items": [
            {"kind": "memo", "id": "m_ffffffff"},
            {"kind": "code", "code": "005930"},
            {"kind": "code", "code": "000660"},
        ]})
        assert r.status_code == 409


def test_code_and_memo_ids_live_in_separate_namespaces(seeded: Path) -> None:
    """kind 를 무시하고 문자열만 비교하면 코드와 메모 id 가 섞인다 — 키에 kind 를
    함께 담는 이유. 같은 문자열을 다른 kind 로 보내면 매칭되지 않아야 한다."""
    with TestClient(_app(seeded)) as c:
        r = c.put(ORDER_URL, json={"ordered_items": [
            {"kind": "code", "code": "005930"},
            {"kind": "code", "code": "000660"},
            # m_0000000a 를 code 로 보낼 수는 없다(패턴 위반) → 422 로 막힌다
            {"kind": "code", "code": "m_00000"},
        ]})
        assert r.status_code == 422


def test_unknown_folder_is_404(seeded: Path) -> None:
    with TestClient(_app(seeded)) as c:
        r = c.put("/api/watchlist/folders/f_ffffffff/items/order",
                  json={"ordered_items": [{"kind": "code", "code": "005930"}]})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "folder_not_found"


def test_unknown_kind_is_422(seeded: Path) -> None:
    """판별 유니온이 미지의 kind 를 거절한다 — 프론트 union 과 갈리면 여기서 막힌다."""
    with TestClient(_app(seeded)) as c:
        r = c.put(ORDER_URL, json={"ordered_items": [{"kind": "divider", "id": "d_1"}]})
        assert r.status_code == 422
