"""Watchlist HTTP route tests (v3, ADR-0070). See spec 2026-05-26 / 2026-06-11."""
from __future__ import annotations

import datetime as dt
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

KST = ZoneInfo("Asia/Seoul")


def _app(tmp_path: Path) -> FastAPI:
    from hoga.api.watchlist_routes import build_router
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


async def _seed_backend(tmp_path: Path, *, code: str, name: str, today_kst_date: str):
    """v3 seed via the service layer: ensure a '기본' folder, add the code as a member."""
    from hoga.api.watchlist import add_member, create_folder, load_document
    doc = load_document(tmp_path)
    fid = doc.folders[0].id if doc.folders else (await create_folder(tmp_path, name="기본")).id
    await add_member(tmp_path, code=code, name=name, today_kst_date=today_kst_date, folder_id=fid)


def _fake_hit(code: str = "003490", name: str = "대한항공"):
    from hoga.api.models import SymbolHit
    return SymbolHit(
        code=code,
        name=name,
        market="KOSPI",
        captured_count=0,
        captured_breakdown={
            "complete": 0,
            "source_partial": 0,
            "client_incomplete": 0,
            "invalid": 0,
        },
    )


@contextmanager
def _folder_client(tmp_path: Path):
    """Client with symbols.search (any code → a hit), now_kst, and a stubbed
    refresh_live_stream patched — the standard setup for folder/member routes."""
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)

    def _search(code, limit=1):
        return [_fake_hit(code=code, name=f"종목{code}")]

    with patch("hoga.api.watchlist_routes.symbols.search", side_effect=_search), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()):
        yield TestClient(_app(tmp_path))


def test_get_empty_watchlist(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == []
    # next_run_at_ms is today's 17:00 KST in Unix-ms.
    expected = int(dt.datetime(2026, 5, 26, 17, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected


@pytest.mark.asyncio
async def test_get_returns_entries(tmp_path: Path):
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, tzinfo=KST)  # after 17 → tomorrow
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["code"] == "003490"
    # 2026-05-27 17:00 KST
    expected = int(dt.datetime(2026, 5, 27, 17, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected


def test_member_add_unknown_code_returns_404(tmp_path: Path):
    """Code must be present in symbol-master cache. 404 because the request
    is well-formed but the referenced resource does not exist."""
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()), \
         patch("hoga.api.watchlist_routes.symbols.search", return_value=[]):
        client = TestClient(_app(tmp_path))
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "999999"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "unknown_code"


def test_member_add_unknown_folder_returns_404(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        r = client.post("/api/watchlist/folders/f_deadbeef/members", json={"code": "003490"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "folder_not_found"


def test_member_add_returns_entry(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490"})
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "003490"
    assert body["name"] == "종목003490"
    assert body["registered_at_kst_date"] == "20260526"
    assert body["last_success_date"] is None


def test_member_add_idempotent_single_membership(tmp_path: Path):
    """v3: adding the same code to the same folder twice is idempotent (no 409)."""
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490"})
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490"})
        body = client.get("/api/watchlist").json()
    assert r.status_code == 201
    assert [e["code"] for e in body["entries"]] == ["003490"]  # single membership


def test_delete_missing_returns_404(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.delete("/api/watchlist/003490")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_watchlist"


@pytest.mark.asyncio
async def test_delete_removes_entry(tmp_path: Path):
    from hoga.api import watchlist
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    client = TestClient(_app(tmp_path))
    r = client.delete("/api/watchlist/003490")
    assert r.status_code == 204
    assert watchlist.load_watchlist(tmp_path) == []


def test_catchup_one_not_in_watchlist_returns_404(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/003490/catchup")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_watchlist"


@pytest.mark.asyncio
async def test_catchup_one_returns_enqueue_response(tmp_path: Path):
    from hoga.api.models import EnqueueResponse, QueueItem
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    fake_resp = EnqueueResponse(
        enqueued=[QueueItem(
            item_id="003490-20260526", code="003490", date="20260526",
            phase="queued", force_retry=False, pause_origin=False,
            enqueued_at_ms=0, attempt=1,
        )],
        deduped=[],
    )
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, return_value=fake_resp):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/003490/catchup")
    assert r.status_code == 201
    body = r.json()
    assert len(body["enqueued"]) == 1
    assert body["enqueued"][0]["code"] == "003490"
    assert body["deduped"] == []


@pytest.mark.asyncio
async def test_catchup_all_aggregates_results(tmp_path: Path):
    from hoga.api.models import EnqueueResponse, QueueItem
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260520")
    await _seed_backend(tmp_path, code="005930", name="삼성전자", today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    def fake_helper(entry, *, data_dir, now):
        if entry.code == "003490":
            return EnqueueResponse(
                enqueued=[QueueItem(
                    item_id="003490-20260526", code="003490", date="20260526",
                    phase="queued", force_retry=False, pause_origin=False,
                    enqueued_at_ms=0,
                )],
                deduped=[],
            )
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, side_effect=fake_helper):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 201
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    assert results["003490"]["enqueued_count"] == 1
    assert results["003490"]["deduped_count"] == 0
    assert results["003490"]["error"] is None
    assert results["005930"]["enqueued_count"] == 0


@pytest.mark.asyncio
async def test_catchup_all_per_entry_failure_does_not_abort(tmp_path: Path):
    from hoga.api.models import EnqueueResponse
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260520")
    await _seed_backend(tmp_path, code="005930", name="삼성전자", today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    def fake_helper(entry, *, data_dir, now):
        if entry.code == "003490":
            raise RuntimeError("some_internal_error")
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, side_effect=fake_helper):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 201
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    assert results["003490"]["error"] == {
        "code": "catchup_failed",
        "message": "Catch-up failed; see server log.",
    }
    assert results["005930"]["error"] is None


@pytest.mark.asyncio
async def test_catchup_all_surfaces_trading_day_unavailable(tmp_path: Path):
    """PR-H(#1044) — **달력이 커버리지 밖일 때만 이 오류가 남는다.**

    원래는 KIS chk-holiday 실패를 몽키패치해 재현했다. 이제 달력은 커밋된 정적
    시드라 조회가 실패하지 않으므로, 이 표면이 오류를 내는 유일한 조건은
    "요청 구간이 달력 커버리지를 넘는다" 이다. 그걸 소스 스텁으로 재현한다.
    """
    from hoga.api import calendar as calendar_module
    from hoga.api.calendar import reset_cache_for_tests

    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    reset_cache_for_tests()
    try:
        with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
             patch.object(
                 calendar_module.trading_days_source, "trading_days",
                 lambda _data_dir=None: frozenset(),
             ):
            client = TestClient(_app(tmp_path))
            r = client.post("/api/watchlist/catchup")
    finally:
        reset_cache_for_tests()
    assert r.status_code == 201
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    assert results["003490"]["error"] == {
        "code": "trading_days_unavailable",
        "message": "Trading-day list unavailable (KIS).",
    }
    assert results["003490"]["enqueued_count"] == 0


def test_catchup_all_empty_watchlist_returns_empty_results(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 201
    assert r.json()["results"] == []


def test_member_add_refreshes_stream(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search", return_value=[_fake_hit()]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()) as ref:
        client = TestClient(_app(tmp_path))
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490"})
    assert r.status_code == 201
    ref.assert_awaited_once()
    assert ref.await_args.kwargs["data_dir"] == tmp_path


@pytest.mark.asyncio
async def test_delete_refreshes_stream(tmp_path: Path):
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    with patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()) as ref:
        client = TestClient(_app(tmp_path))
        r = client.delete("/api/watchlist/003490")
    assert r.status_code == 204
    ref.assert_awaited_once()
    assert ref.await_args.kwargs["data_dir"] == tmp_path


def test_member_add_survives_refresh_stream_failure(tmp_path: Path):
    """If refresh_live_stream raises, the add still returns 201 — the disk
    mutation already succeeded; stream re-sync is best-effort."""
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search", return_value=[_fake_hit()]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.refresh_live_stream",
               new=AsyncMock(side_effect=OSError("boom"))):
        client = TestClient(_app(tmp_path))
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490"})
    assert r.status_code == 201
    from hoga.api import watchlist
    assert any(e.code == "003490" for e in watchlist.load_watchlist(tmp_path))


@pytest.mark.asyncio
async def test_delete_survives_refresh_stream_failure(tmp_path: Path):
    """If refresh_live_stream raises, the delete still returns 204."""
    from hoga.api import watchlist
    await _seed_backend(tmp_path, code="003490", name="대한항공", today_kst_date="20260526")
    with patch("hoga.api.watchlist_routes.refresh_live_stream",
               new=AsyncMock(side_effect=OSError("boom"))):
        client = TestClient(_app(tmp_path))
        r = client.delete("/api/watchlist/003490")
    assert r.status_code == 204
    assert watchlist.load_watchlist(tmp_path) == []


# --- Folder + member/reorder/bulk routes -----------------------------------


def test_get_returns_folders_and_entry_folder_id(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
        body = client.get("/api/watchlist").json()
    assert body["folders"][0]["id"] == fid
    assert next(e for e in body["entries"] if e["code"] == "005930")["folder_id"] == fid


def test_member_remove_route(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
        assert client.delete(f"/api/watchlist/folders/{fid}/members/005930").status_code == 204
        assert client.get("/api/watchlist").json()["entries"] == []


def test_folder_crud_routes(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "A"}).json()["id"]
        assert client.patch(f"/api/watchlist/folders/{fid}", json={"name": "B"}).status_code == 204
        assert client.get("/api/watchlist").json()["folders"][0]["name"] == "B"
        assert client.delete(f"/api/watchlist/folders/{fid}").status_code == 204
        assert client.get("/api/watchlist").json()["folders"] == []


def test_folder_reorder_route(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        a = client.post("/api/watchlist/folders", json={"name": "A"}).json()["id"]
        b = client.post("/api/watchlist/folders", json={"name": "B"}).json()["id"]
        assert client.put("/api/watchlist/folders/order", json={"ordered_ids": [b, a]}).status_code == 204
        assert [f["name"] for f in client.get("/api/watchlist").json()["folders"]] == ["B", "A"]


def test_create_folder_response_includes_capture_disabled(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        r = client.post("/api/watchlist/folders", json={"name": "스윙"})

    assert r.status_code == 201
    assert r.json()["capture_enabled"] is False


def test_patch_folder_capture_refreshes_live_stream(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        with patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()) as ref:
            r = client.patch(
                f"/api/watchlist/folders/{fid}/capture",
                json={"capture_enabled": True},
            )

    assert r.status_code == 200
    assert r.json()["capture_enabled"] is True
    ref.assert_awaited_once()


def test_patch_folder_capture_unknown_folder_returns_404(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        r = client.patch(
            "/api/watchlist/folders/f_deadbeef/capture",
            json={"capture_enabled": True},
        )

    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "folder_not_found"


def test_reorder_and_bulk_remove_routes(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        for c in ("005930", "000660"):
            client.post(f"/api/watchlist/folders/{fid}/members", json={"code": c})
        r = client.put("/api/watchlist/reorder",
                       json={"folder_id": fid, "ordered_codes": ["000660", "005930"]})
        assert r.status_code == 204
        assert client.post("/api/watchlist/remove",
                           json={"codes": ["005930", "000660"]}).status_code == 204
        assert client.get("/api/watchlist").json()["entries"] == []


def test_folder_create_whitespace_name_returns_422(tmp_path: Path):
    """A whitespace-only name strips to "" and must be rejected with a clean 422."""
    with _folder_client(tmp_path) as client:
        r = client.post("/api/watchlist/folders", json={"name": "   "})
    assert r.status_code == 422


def test_folder_rename_whitespace_name_returns_422(tmp_path: Path):
    """PATCH rename rejects a whitespace-only name with 422 (see create test)."""
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "A"}).json()["id"]
        r = client.patch(f"/api/watchlist/folders/{fid}", json={"name": "   "})
    assert r.status_code == 422


# ── 순서 변경 엔드포인트가 Live Set refresh를 호출 (v3: move 라우트 폐지) ──────

def _order_change_app(tmp_path):
    from hoga.api.app import create_app
    return TestClient(create_app(tmp_path))


@pytest.mark.parametrize(
    ("method", "path", "payload", "mutator"),
    [
        ("put", "/api/watchlist/reorder",
         {"folder_id": "f_abc12345", "ordered_codes": []}, "reorder_entries"),
        ("put", "/api/watchlist/folders/order",
         {"ordered_ids": []}, "reorder_folders"),
        ("delete", "/api/watchlist/folders/f_abc12345", None, "delete_folder"),
    ],
)
def test_order_change_endpoints_refresh_live_stream(
    tmp_path: Path, method: str, path: str, payload, mutator: str,
):
    with patch(f"hoga.api.watchlist_routes.{mutator}", new=AsyncMock()), \
         patch("hoga.api.watchlist_routes.refresh_live_stream", new=AsyncMock()) as ref:
        client = _order_change_app(tmp_path)
        if method == "delete":  # noqa: SIM108 — 삼항이 오히려 읽기 어려운 자리
            r = client.delete(path)
        else:
            r = getattr(client, method)(path, json=payload)
        assert r.status_code in (200, 204)
        ref.assert_awaited_once()


# --- POST members 의 `at` (패널 우클릭 "위에 종목 추가") ---------------------
# **라우트 레벨에서 재는 것이 핵심이다.** store 테스트만 두면 "요청 모델엔 at 이 있고
# store 도 at 을 받는데 라우트가 안 꿰는" 무증상 결함을 못 본다(#1366 과 같은 계열) —
# 그 경우 삽입은 조용히 맨 아래로 떨어지고 에러는 나지 않는다.


def _display_order(body) -> list[str]:
    """GET /api/watchlist 응답을 폴더 표시 순서 한 줄로 — 코드와 메모가 같은 축이다."""
    rows = ([(e["order"], f"c:{e['code']}") for e in body["entries"]]
            + [(m["order"], f"m:{m['id']}") for m in body["memos"]])
    return [k for _, k in sorted(rows)]


def test_member_add_at_lands_at_the_requested_index(tmp_path: Path):
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "000660"})
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490", "at": 1})
        body = client.get("/api/watchlist").json()
    assert r.status_code == 201
    assert _display_order(body) == ["c:005930", "c:003490", "c:000660"]


def test_member_add_at_shares_the_index_axis_with_memos(tmp_path: Path):
    """메모가 낀 폴더에서도 at 이 **보이는 자리**를 가리킨다 — 두 배열이 한 축이다."""
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
        mid = client.post(f"/api/watchlist/folders/{fid}/memos", json={"text": "구간"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "000660"})
        # 화면상 3번째 행(메모 다음, 000660 자리)에 삽입 → 000660 이 아래로 밀린다.
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "003490", "at": 2})
        body = client.get("/api/watchlist").json()
    assert _display_order(body) == ["c:005930", f"m:{mid}", "c:003490", "c:000660"]


def test_member_add_without_at_still_appends(tmp_path: Path):
    """at 미전달은 기존 계약 그대로 맨 아래 — 추가 폼·하트 버튼이 이 경로를 쓴다."""
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930"})
        client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "000660"})
        body = client.get("/api/watchlist").json()
    assert _display_order(body) == ["c:005930", "c:000660"]


def test_member_add_negative_at_is_422(tmp_path: Path):
    """음수는 클램프하지 않고 거절한다(ge=0) — 오타·계산 실수를 조용히 0 으로 만들지 않는다."""
    with _folder_client(tmp_path) as client:
        fid = client.post("/api/watchlist/folders", json={"name": "스윙"}).json()["id"]
        r = client.post(f"/api/watchlist/folders/{fid}/members", json={"code": "005930", "at": -1})
    assert r.status_code == 422
