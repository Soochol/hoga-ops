from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live.api import build_router


def _client(tmp_path):
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    return TestClient(app)


def _client_without_data_dir():
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=None))
    return TestClient(app)


def test_index_sector_rankings_rejects_invalid_date(tmp_path) -> None:
    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=2026-06-19")

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "invalid_date"


def test_index_sector_rankings_rejects_future_date(tmp_path, monkeypatch) -> None:
    monkeypatch.setattr(live_api, "_today_kst_yyyymmdd", lambda: "20260619")

    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=20260620")

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "date_in_future"


def test_index_sector_rankings_returns_503_without_data_dir(monkeypatch) -> None:
    monkeypatch.setattr(live_api, "_today_kst_yyyymmdd", lambda: "20260619")

    res = _client_without_data_dir().get("/api/live/index-sector-rankings?date=20260619")

    assert res.status_code == 503


def test_index_sector_rankings_returns_service_payload(tmp_path, monkeypatch) -> None:
    calls = []

    class FakeResponse:
        def model_dump(self, *args, **kwargs):
            return {
                "date": "20260619",
                "source": "daily_adjusted",
                "unavailable_reason": None,
                "sectors": [],
            }

    def fake_build(data_dir, basis_date, *, intraday_prices=None):
        calls.append((data_dir, basis_date, intraday_prices))
        return FakeResponse()

    monkeypatch.setattr(live_api, "build_index_sector_rankings", fake_build)

    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=20260619")

    assert res.status_code == 200
    assert calls == [(tmp_path, "20260619", None)]
    assert res.json() == {
        "date": "20260619",
        "source": "daily_adjusted",
        "unavailable_reason": None,
        "sectors": [],
    }


def test_index_sector_rankings_runs_off_the_event_loop(tmp_path, monkeypatch) -> None:
    """히트맵 전 종목 parquet 스캔이 루프 스레드에서 돌면 프로세스 전체가 멈춘다.

    60초 폴링 엔드포인트라 열린 탭마다 주기적으로 재발한다. 벽시계를 재지 않고
    **실행 스레드에 running loop 가 없다**로 표현한다 — 루프에서 실행됐다면
    ``get_running_loop()`` 이 성공하므로 거짓 통과가 불가능하다.
    """
    import asyncio

    observed: dict[str, bool] = {}

    class FakeResponse:
        def model_dump(self, *args, **kwargs):
            return {
                "date": "20260619",
                "source": "daily_adjusted",
                "unavailable_reason": None,
                "sectors": [],
            }

    def fake_build(data_dir, basis_date, *, intraday_prices=None):
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            observed["on_loop_thread"] = False
        else:
            observed["on_loop_thread"] = True
        return FakeResponse()

    monkeypatch.setattr(live_api, "_today_kst_yyyymmdd", lambda: "20260619")
    monkeypatch.setattr(live_api, "build_index_sector_rankings", fake_build)

    res = _client(tmp_path).get("/api/live/index-sector-rankings?date=20260619")

    assert res.status_code == 200
    assert observed["on_loop_thread"] is False, (
        "동기 parquet 스캔이 이벤트 루프를 차단한다 — asyncio.to_thread 로 감싸야 한다"
    )
