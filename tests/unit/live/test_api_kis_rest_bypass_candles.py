from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live import kis_runtime, lifecycle
from hoga.live.api import build_router
from hoga.live.kis_client import DailyCandleFetchResult, IndexCandleFetchResult
from hoga.live.settings import update_live_settings


class _CountingKis:
    def __init__(self) -> None:
        self.minute_fetch_count = 0
        self.daily_fetch_count = 0
        self.index_daily_fetch_count = 0
        self.index_minute_fetch_count = 0

    async def fetch_past_minute_candles(self, *_args, **_kwargs):
        self.minute_fetch_count += 1
        return []

    async def fetch_past_daily_candles(self, *_args, **_kwargs):
        self.daily_fetch_count += 1

        return DailyCandleFetchResult(candles=[], violations=[])

    async def fetch_index_daily_candles(self, *_args, **_kwargs):
        self.index_daily_fetch_count += 1

        return IndexCandleFetchResult(candles=[], violations=[])

    async def fetch_index_minute_candles(self, *_args, **_kwargs):
        self.index_minute_fetch_count += 1

        return IndexCandleFetchResult(candles=[], violations=[])


def _bypass_app(tmp_path, fake_kis: _CountingKis) -> FastAPI:
    lifecycle.reset_for_tests()
    live_api.index_candles_cache_instance = None
    live_api.index_minute_candles_cache_instance = None
    kis_runtime.set_kis_client(fake_kis)  # type: ignore[arg-type]
    update_live_settings(tmp_path, kis_rest_bypass_enabled=True)

    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            data_dir=tmp_path,
        )
    )
    return app


def test_past_candles_bypass_serves_cache_only_on_miss(tmp_path, monkeypatch) -> None:
    fake = _CountingKis()
    app = _bypass_app(tmp_path, fake)
    run_with_capacity_calls = 0

    async def fake_run_with_capacity(*_args, **_kwargs):
        nonlocal run_with_capacity_calls
        run_with_capacity_calls += 1
        raise AssertionError("run_with_capacity must not be called during KIS REST bypass")

    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)

    with TestClient(app, raise_server_exceptions=False) as c:
        response = c.get("/api/live/past-candles?code=005930&from=20240102&to=20240102")

    assert response.status_code == 200
    assert response.json()["data_warnings"][0]["reason"] == "kis_rest_bypassed"
    assert run_with_capacity_calls == 0
    assert fake.minute_fetch_count == 0


def test_past_daily_candles_bypass_serves_cache_only_on_miss(tmp_path, monkeypatch) -> None:
    fake = _CountingKis()
    app = _bypass_app(tmp_path, fake)
    run_with_capacity_calls = 0

    async def fake_run_with_capacity(*_args, **_kwargs):
        nonlocal run_with_capacity_calls
        run_with_capacity_calls += 1
        raise AssertionError("run_with_capacity must not be called during KIS REST bypass")

    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)

    with TestClient(app, raise_server_exceptions=False) as c:
        response = c.get("/api/live/past-daily-candles?code=005930&from=20240102&to=20240102")

    assert response.status_code == 200
    assert response.json()["data_warnings"][0]["reason"] == "kis_rest_bypassed"
    assert run_with_capacity_calls == 0
    assert fake.daily_fetch_count == 0


@pytest.mark.parametrize(
    ("timeframe", "fetch_count_attr"),
    [("D", "index_daily_fetch_count"), ("1m", "index_minute_fetch_count")],
)
def test_index_candles_bypass_serves_cache_only_on_miss(
    tmp_path,
    monkeypatch,
    timeframe: str,
    fetch_count_attr: str,
) -> None:
    fake = _CountingKis()
    app = _bypass_app(tmp_path, fake)
    run_with_capacity_calls = 0

    async def fake_run_with_capacity(*_args, **_kwargs):
        nonlocal run_with_capacity_calls
        run_with_capacity_calls += 1
        raise AssertionError("run_with_capacity must not be called during KIS REST bypass")

    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)

    with TestClient(app, raise_server_exceptions=False) as c:
        response = c.get(
            "/api/live/index-candles?"
            f"index_id=KOSPI&timeframe={timeframe}&from=20240102&to=20240102"
        )

    assert response.status_code == 200
    assert response.json()["data_warnings"][0]["reason"] == "kis_rest_bypassed"
    assert run_with_capacity_calls == 0
    assert getattr(fake, fetch_count_attr) == 0
