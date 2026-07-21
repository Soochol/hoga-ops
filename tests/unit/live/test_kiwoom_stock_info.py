"""kiwoom_stock_info (ka10001) — 파서 골든 + fetcher 캐시/single-flight.

골든 값은 2026-07-21 실호출(018260 삼성에스디에스) 응답에서 그대로 옮겼다.
산술 관계(상한가 = 기준가×1.3 틱 반올림)가 성립하는 실측값이라 동어반복이 아니다.
"""
from __future__ import annotations

import asyncio
import json

import httpx
import pytest

from hoga.live.kiwoom_stock_info import (
    KiwoomStockInfoError,
    KiwoomStockInfoFetcher,
    parse_ka10001,
)

# 실호출 응답 부분집합(2026-07-21). 부호 prefix·8자리 날짜가 실제 wire 형식이다.
GOLDEN_018260 = {
    "return_code": 0,
    "return_msg": "정상적으로 처리되었습니다",
    "stk_cd": "018260",
    "stk_nm": "삼성에스디에스",
    "base_pric": "185800",
    "upl_pric": "+241500",
    "lst_pric": "-130100",
    "250hgst": "+388500",
    "250lwst": "-143700",
    "250hgst_pric_dt": "20260601",
    "250lwst_pric_dt": "20250903",
}


class _FakeTokenProvider:
    def __init__(self) -> None:
        self.calls = 0

    def get_token(self) -> str:
        self.calls += 1
        return "fake-token"


def test_parse_golden_frame_strips_sign_prefix():
    out = parse_ka10001("018260", GOLDEN_018260)
    assert out.code == "018260"
    assert out.base_price == 185800
    assert out.upper_limit == 241500
    assert out.lower_limit == 130100
    assert out.high_250 == 388500
    assert out.low_250 == 143700
    assert out.high_250_date == "20260601"
    assert out.low_250_date == "20250903"
    # 실측 산술 관계 재확인: 상한가 = 기준가 × 1.3 을 호가단위로 반올림한 값.
    assert abs(out.upper_limit - out.base_price * 1.3) < 500


def test_parse_missing_or_zero_fields_become_none():
    body = {**GOLDEN_018260, "upl_pric": "", "250hgst": "0", "250lwst_pric_dt": "-"}
    out = parse_ka10001("018260", body)
    assert out.upper_limit is None
    assert out.high_250 is None
    assert out.low_250_date is None
    assert out.lower_limit == 130100  # 다른 필드는 영향 없음


def _fetcher(handler) -> tuple[KiwoomStockInfoFetcher, _FakeTokenProvider]:
    prov = _FakeTokenProvider()
    fetcher = KiwoomStockInfoFetcher(
        prov,  # type: ignore[arg-type] — get_token 프로토콜만 쓴다
        _transport=httpx.MockTransport(handler),
    )
    return fetcher, prov


def test_fetch_sends_api_id_header_and_parses():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=GOLDEN_018260)

    fetcher, _ = _fetcher(handler)
    limits, fetched_at_ms = asyncio.run(fetcher.get("018260"))
    assert limits.upper_limit == 241500
    assert fetched_at_ms > 0
    req = seen[0]
    assert req.headers["api-id"] == "ka10001"
    assert req.headers["authorization"] == "Bearer fake-token"
    assert json.loads(req.content) == {"stk_cd": "018260"}
    fetcher.close()


def test_same_day_cache_hits_upstream_once():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=GOLDEN_018260)

    fetcher, _ = _fetcher(handler)

    async def scenario() -> None:
        # 동시 2건 — single-flight 로 상류 1회만 나가야 한다.
        a, b = await asyncio.gather(fetcher.get("018260"), fetcher.get("018260"))
        assert a[0] == b[0]
        # 웜 캐시 재호출도 상류 0회 추가.
        await fetcher.get("018260")

    asyncio.run(scenario())
    assert calls == 1
    fetcher.close()


def test_error_return_code_raises_and_is_not_cached():
    bodies = [
        {"return_code": 3, "return_msg": "조회 실패"},
        GOLDEN_018260,
    ]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=bodies.pop(0))

    fetcher, _ = _fetcher(handler)

    async def scenario() -> None:
        with pytest.raises(KiwoomStockInfoError):
            await fetcher.get("018260")
        limits, _ts = await fetcher.get("018260")  # 실패 미캐시 → 재시도 성공
        assert limits.upper_limit == 241500

    asyncio.run(scenario())
    fetcher.close()


def test_http_error_raises():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, text="boom")

    fetcher, _ = _fetcher(handler)
    with pytest.raises(KiwoomStockInfoError):
        asyncio.run(fetcher.get("018260"))
    fetcher.close()


# --- /api/live/stock-limits 라우트 ---


@pytest.fixture()
def _hermetic_kiwoom_env(monkeypatch):
    """빌드 시 ensure_token_provider_for_account 가 개발자 실키를 집어들지 않게."""
    for k in ("KIWOOM_APP_KEY", "KIWOOM_APP_SECRET"):
        monkeypatch.delenv(k, raising=False)


def _route_client(tmp_path):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live import lifecycle
    from hoga.live.api import build_router

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    return TestClient(app)


def test_stock_limits_route_returns_parsed_fields(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    from hoga.live import api as live_api

    fetcher, _prov = _fetcher(lambda request: httpx.Response(200, json=GOLDEN_018260))
    monkeypatch.setattr(live_api, "kiwoom_stock_info_fetcher_instance", fetcher)
    r = _route_client(tmp_path).get("/api/live/stock-limits", params={"code": "018260"})
    assert r.status_code == 200
    body = r.json()
    assert body["upper_limit"] == 241500
    assert body["lower_limit"] == 130100
    assert body["high_250"] == 388500
    assert body["low_250"] == 143700
    assert body["source"] == "kiwoom"
    fetcher.close()


def test_stock_limits_route_503_without_credentials(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    from hoga.live import api as live_api

    monkeypatch.setattr(live_api, "kiwoom_stock_info_fetcher_instance", None)
    r = _route_client(tmp_path).get("/api/live/stock-limits", params={"code": "018260"})
    assert r.status_code == 503


def test_stock_limits_route_422_on_bad_code(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    from hoga.live import api as live_api

    monkeypatch.setattr(live_api, "kiwoom_stock_info_fetcher_instance", None)
    r = _route_client(tmp_path).get("/api/live/stock-limits", params={"code": "abc"})
    assert r.status_code == 422
