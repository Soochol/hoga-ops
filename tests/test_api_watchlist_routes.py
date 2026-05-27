"""Watchlist HTTP route tests. See spec 2026-05-26."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from unittest.mock import patch
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


def test_get_empty_watchlist(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert body["entries"] == []
    # next_run_at_ms is today's 18:00 KST in Unix-ms.
    expected = int(dt.datetime(2026, 5, 26, 18, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected


@pytest.mark.asyncio
async def test_get_returns_entries(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, tzinfo=KST)  # after 18 → tomorrow
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.get("/api/watchlist")
    assert r.status_code == 200
    body = r.json()
    assert len(body["entries"]) == 1
    assert body["entries"][0]["code"] == "003490"
    # 2026-05-27 18:00 KST
    expected = int(dt.datetime(2026, 5, 27, 18, 0, tzinfo=KST).timestamp() * 1000)
    assert body["next_run_at_ms"] == expected


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


def test_post_unknown_code_returns_404(tmp_path: Path):
    """Code must be present in symbol-master cache. 404 because the request
    is well-formed (Pydantic validated the 6-digit pattern) but the
    referenced resource does not exist."""
    with patch("hoga.api.watchlist_routes.symbols.search", return_value=[]):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "999999"})
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "unknown_code"


def test_post_adds_entry(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search",
               return_value=[_fake_hit()]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "003490"})
    assert r.status_code == 201
    body = r.json()
    assert body["code"] == "003490"
    assert body["name"] == "대한항공"
    assert body["registered_at_kst_date"] == "20260526"
    assert body["last_success_date"] is None


def test_post_duplicate_returns_409(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 26, 10, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.symbols.search",
               return_value=[_fake_hit()]), \
         patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        client.post("/api/watchlist", json={"code": "003490"})
        r = client.post("/api/watchlist", json={"code": "003490"})
    assert r.status_code == 409
    assert r.json()["detail"]["code"] == "already_in_watchlist"


def test_delete_missing_returns_404(tmp_path: Path):
    client = TestClient(_app(tmp_path))
    r = client.delete("/api/watchlist/003490")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_in_watchlist"


@pytest.mark.asyncio
async def test_delete_removes_entry(tmp_path: Path):
    from hoga.api import watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
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
    from unittest.mock import AsyncMock

    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse, QueueItem
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
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
    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse, QueueItem
    from unittest.mock import AsyncMock
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
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
    from hoga.api import watchlist
    from hoga.api.models import EnqueueResponse
    from unittest.mock import AsyncMock
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)

    def fake_helper(entry, *, data_dir, now):
        if entry.code == "003490":
            raise RuntimeError("krx_credentials_missing")
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now), \
         patch("hoga.api.watchlist_routes.catchup_one_entry",
               new_callable=AsyncMock, side_effect=fake_helper):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 201
    body = r.json()
    results = {row["code"]: row for row in body["results"]}
    # Generic RuntimeError → stable code 'catchup_failed' (no raw exception
    # strings leak). The exception detail goes to server log only.
    assert results["003490"]["error"] == {
        "code": "catchup_failed",
        "message": "Catch-up failed; see server log.",
    }
    assert results["005930"]["error"] is None


def test_catchup_all_empty_watchlist_returns_empty_results(tmp_path: Path):
    fake_now = dt.datetime(2026, 5, 27, 19, 0, tzinfo=KST)
    with patch("hoga.api.watchlist_routes.now_kst", return_value=fake_now):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist/catchup")
    assert r.status_code == 201
    assert r.json()["results"] == []
