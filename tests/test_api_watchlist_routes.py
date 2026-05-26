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


def test_post_unknown_code_returns_400(tmp_path: Path):
    """Code must be present in symbol-master cache."""
    with patch("hoga.api.watchlist_routes.symbols.search", return_value=[]):
        client = TestClient(_app(tmp_path))
        r = client.post("/api/watchlist", json={"code": "999999"})
    assert r.status_code == 400
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
