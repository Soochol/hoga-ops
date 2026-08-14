"""메모("빈칸") HTTP 라우트 (v4) — 실제 왕복으로 wire 계약을 잰다.

**엔드포인트 함수를 직접 부르지 않고 TestClient 를 쓰는 것이 핵심이다.** 직접 호출은
FastAPI 의 `response_model` 단계를 건너뛰므로, 모델이 불완전해 필드가 **조용히
스트립되는** 사고를 원리적으로 볼 수 없다(CLAUDE.md 가 경고하는 실패 유형). 여기서
재는 것은 서비스 로직이 아니라 **바이트로 나가는 JSON** 이다.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import (
    WatchlistDocument,
    WatchlistEntry,
    WatchlistFolder,
    code_items,
)
from hoga.api.watchlist import save_document


def _app(tmp_path: Path) -> FastAPI:
    from hoga.api.watchlist_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


@pytest.fixture
def seeded(tmp_path: Path) -> Path:
    save_document(tmp_path, WatchlistDocument(
        folders=[WatchlistFolder(id="f_0000000a", name="스윙", order=0,
                                 items=code_items(["005930", "000660"]))],
        entries=[WatchlistEntry(code=c, name=c, registered_at_kst_date="20260101")
                 for c in ("005930", "000660")],
    ))
    return tmp_path


def test_get_watchlist_ships_a_memos_array(seeded: Path) -> None:
    """`memos` 키가 실제 응답 바디에 **존재**한다 — 비어 있어도 키는 나간다.

    키가 통째로 빠지면 프론트는 `undefined.map` 으로 죽거나, 옵셔널 처리했다면
    "메모가 하나도 없다" 로 조용히 오독한다.
    """
    with TestClient(_app(seeded)) as c:
        body = c.get("/api/watchlist").json()
    assert "memos" in body, "response_model 이 memos 를 스트립했다"
    assert body["memos"] == []


def test_memo_round_trip_through_http(seeded: Path) -> None:
    with TestClient(_app(seeded)) as c:
        r = c.post("/api/watchlist/folders/f_0000000a/memos",
                   json={"text": "실적 발표 대기", "at": 1})
        assert r.status_code == 201
        created = r.json()
        # 생성 응답의 필드가 전부 살아 나오는가(스트립 검사)
        assert set(created) == {"id", "folder_id", "order", "text"}
        assert created["folder_id"] == "f_0000000a"
        assert created["order"] == 1
        assert created["text"] == "실적 발표 대기"

        body = c.get("/api/watchlist").json()
        assert body["memos"] == [created]
        # 같은 축: 코드는 items 인덱스 0,2 를 갖고 메모가 1 을 채운다
        assert sorted(e["order"] for e in body["entries"]) == [0, 2]

        r = c.patch(f"/api/watchlist/memos/{created['id']}", json={"text": "수정됨"})
        assert r.status_code == 200
        assert r.json()["text"] == "수정됨"

        assert c.delete(f"/api/watchlist/memos/{created['id']}").status_code == 204
        assert c.get("/api/watchlist").json()["memos"] == []


def test_blank_text_is_accepted_and_shipped(seeded: Path) -> None:
    """빈 줄이 목적이므로 `text=""` 는 422 가 아니라 201 이다.

    폴더 이름 body(`_FolderNameBody`)는 blank 를 거절한다 — 그 validator 를 실수로
    재사용하면 이 테스트가 잡는다.
    """
    with TestClient(_app(seeded)) as c:
        r = c.post("/api/watchlist/folders/f_0000000a/memos", json={"text": ""})
        assert r.status_code == 201, r.text
        assert r.json()["text"] == ""
        # 공백만 보내도 빈 줄로 정규화된다(거절이 아니다)
        r2 = c.post("/api/watchlist/folders/f_0000000a/memos", json={"text": "   "})
        assert r2.status_code == 201
        assert r2.json()["text"] == ""


def test_text_over_the_limit_is_rejected(seeded: Path) -> None:
    from hoga.api.models import WATCHLIST_MEMO_MAX_LEN
    with TestClient(_app(seeded)) as c:
        r = c.post("/api/watchlist/folders/f_0000000a/memos",
                   json={"text": "가" * (WATCHLIST_MEMO_MAX_LEN + 1)})
        assert r.status_code == 422


def test_at_beyond_the_end_clamps_instead_of_422(seeded: Path) -> None:
    """동시 편집으로 길이가 줄었을 뿐인 흔한 경우라 에러를 보이지 않는다."""
    with TestClient(_app(seeded)) as c:
        r = c.post("/api/watchlist/folders/f_0000000a/memos", json={"text": "끝", "at": 99})
        assert r.status_code == 201
        assert r.json()["order"] == 2  # 코드 2개 뒤


def test_unknown_folder_and_memo_are_404(seeded: Path) -> None:
    with TestClient(_app(seeded)) as c:
        r = c.post("/api/watchlist/folders/f_ffffffff/memos", json={"text": "x"})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "folder_not_found"

        r = c.patch("/api/watchlist/memos/m_ffffffff", json={"text": "x"})
        assert r.status_code == 404
        assert r.json()["detail"]["code"] == "memo_not_found"

        assert c.delete("/api/watchlist/memos/m_ffffffff").status_code == 404


def test_memo_routes_do_not_disturb_membership(seeded: Path) -> None:
    """메모 CRUD 는 종목 멤버십을 건드리지 않는다 — entries 가 그대로여야 한다."""
    with TestClient(_app(seeded)) as c:
        before = c.get("/api/watchlist").json()["entries"]
        mid = c.post("/api/watchlist/folders/f_0000000a/memos",
                     json={"text": "구분", "at": 0}).json()["id"]
        c.delete(f"/api/watchlist/memos/{mid}")
        after = c.get("/api/watchlist").json()["entries"]
        assert [e["code"] for e in before] == [e["code"] for e in after]
        assert [e["order"] for e in before] == [e["order"] for e in after]
