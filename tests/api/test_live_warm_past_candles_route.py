from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live import lifecycle
from hoga.live.api import build_router


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    return TestClient(app)


def _wired_client(tmp_path, monkeypatch) -> TestClient:
    """data_dir이 배선된 라우터 → minute_backfill 이 non-None이라 상태 분기
    (bypassed / kis_unavailable)까지 도달한다. 스케줄러 팩토리를 패치해
    _kis_scheduler 를 non-None으로 만든다 (실 KIS 없이)."""
    monkeypatch.setattr(
        live_api, "ensure_kis_capacity_scheduler", lambda data_dir: object(),
    )
    app = FastAPI()
    app.include_router(
        build_router(get_status=lifecycle.get_status, data_dir=tmp_path),
    )
    return TestClient(app)


def test_warm_route_422_on_bad_code() -> None:
    r = _client().post("/api/live/warm-past-candles?code=abc")
    assert r.status_code == 422


def test_warm_route_422_on_bad_venue() -> None:
    r = _client().post("/api/live/warm-past-candles?code=005930&venue=NASDAQ")
    assert r.status_code == 422


def test_warm_route_503_when_cache_not_wired() -> None:
    # data_dir 미배선 → minute_backfill None → 503 (기존 /past-candles와 동일 계약)
    r = _client().post("/api/live/warm-past-candles?code=005930")
    assert r.status_code == 503


def test_warm_route_kis_unavailable_status(tmp_path, monkeypatch) -> None:
    # bypass OFF + capacity candidate False → warm_minute 호출 없이
    # 200 + status="kis_unavailable" (best-effort 계약).
    monkeypatch.setattr(
        live_api.kis_access, "kis_rest_bypass_enabled", lambda data_dir: False,
    )
    monkeypatch.setattr(
        live_api.kis_access, "has_rest_capacity", lambda data_dir: False,
    )
    r = _wired_client(tmp_path, monkeypatch).post(
        "/api/live/warm-past-candles?code=005930",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "kis_unavailable"
    assert body["code"] == "005930"


def test_warm_route_bypassed_status(tmp_path, monkeypatch) -> None:
    # bypass ON → 스케줄러/capacity 검사 이전에 200 + status="bypassed".
    monkeypatch.setattr(
        live_api.kis_access, "kis_rest_bypass_enabled", lambda data_dir: True,
    )
    r = _wired_client(tmp_path, monkeypatch).post(
        "/api/live/warm-past-candles?code=005930",
    )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "bypassed"
    assert body["code"] == "005930"
