"""kiwoom_rankings (rkinfo 4종) — 파서 골든 + fetcher TTL/single-flight/게이트.

골든 응답은 스펙 실측(docs/research/2026-07-22-kiwoom-ranking-tr-spec.md)의 필드
구조를 따른다 — 부호 prefix 문자열·kind별 배열 래퍼 키가 실제 wire 형식이다.
"""
from __future__ import annotations

import asyncio
import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from hoga.live.kiwoom_rankings import (
    KiwoomRankingsError,
    KiwoomRankingsFetcher,
    _build_body,
    parse_rankings,
)

_KST = timezone(timedelta(hours=9))

# 각 kind 의 배열 래퍼 키 + 대표 행(부호 prefix 형식).
GOLDEN_CHANGE = {
    "return_code": 0,
    "return_msg": "정상적으로 처리되었습니다",
    "pred_pre_flu_rt_upper": [
        {"stk_cd": "294870", "stk_nm": "HDC현대산업개발", "cur_prc": "+24350", "flu_rt": "+29.97"},
        {"stk_cd": "095340", "stk_nm": "ISC", "cur_prc": "+89400", "flu_rt": "+24.51"},
    ],
}
GOLDEN_SURGE = {
    "return_code": 0,
    "trde_qty_sdnin": [
        {"stk_cd": "058610", "stk_nm": "에스피지", "cur_prc": "+31900", "flu_rt": "+15.40", "sdnin_rt": "+1842.00"},
    ],
}
GOLDEN_VOLUME = {
    "return_code": 0,
    "tdy_trde_qty_upper": [
        {"stk_cd": "137310", "stk_nm": "에스디바이오센서", "cur_prc": "-11840", "flu_rt": "-18.32", "trde_qty": "98420000"},
    ],
}
GOLDEN_VALUE = {
    "return_code": 0,
    "trde_prica_upper": [
        {"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "+71200", "flu_rt": "+5.79", "now_rank": "1", "trde_prica": "3119200"},
    ],
}


class _FakeTokenProvider:
    def get_token(self) -> str:
        return "fake-token"


def _open_now() -> datetime:
    """정규장 시간대(월요일 10:00 KST)."""
    return datetime(2026, 7, 20, 10, 0, tzinfo=_KST)


# --- 파서 ---


def test_parse_change_preserves_sign_and_ranks():
    rows = parse_rankings("change", GOLDEN_CHANGE)
    assert [r.rank for r in rows] == [1, 2]
    assert rows[0].code == "294870"
    assert rows[0].name == "HDC현대산업개발"
    assert rows[0].price == 24350  # cur_prc 부호 벗김(크기만)
    assert rows[0].change_pct == 29.97  # flu_rt 부호 보존(+)


def test_parse_volume_negative_change_kept():
    rows = parse_rankings("volume", GOLDEN_VOLUME)
    assert rows[0].price == 11840  # 하락종목도 가격은 양수 크기
    assert rows[0].change_pct == -18.32  # 음수 부호 보존


def test_parse_all_four_wrapper_keys_resolve():
    assert len(parse_rankings("change", GOLDEN_CHANGE)) == 2
    assert len(parse_rankings("surge", GOLDEN_SURGE)) == 1
    assert len(parse_rankings("volume", GOLDEN_VOLUME)) == 1
    assert len(parse_rankings("value", GOLDEN_VALUE)) == 1


def test_parse_missing_wrapper_key_yields_empty():
    assert parse_rankings("change", {"return_code": 0}) == ()


def test_parse_skips_rows_without_code():
    body = {"pred_pre_flu_rt_upper": [{"stk_nm": "무코드"}, {"stk_cd": "005930", "stk_nm": "삼성전자", "cur_prc": "+71200", "flu_rt": "+1.0"}]}
    rows = parse_rankings("change", body)
    assert len(rows) == 1
    assert rows[0].code == "005930"
    assert rows[0].rank == 2  # 순위는 원본 인덱스(스킵해도 유지)


def test_double_minus_lower_limit_parsed_negative():
    body = {"pred_pre_flu_rt_upper": [{"stk_cd": "000001", "stk_nm": "X", "cur_prc": "-500", "flu_rt": "--29.97"}]}
    rows = parse_rankings("change", body)
    assert rows[0].change_pct == -29.97


# --- 요청 body ---


def test_change_body_direction_maps_sort_tp():
    assert _build_body("change", "all", "up")["sort_tp"] == "1"
    assert _build_body("change", "all", "down")["sort_tp"] == "3"


def test_market_code_zeropad():
    assert _build_body("value", "all", "up")["mrkt_tp"] == "000"
    assert _build_body("value", "kospi", "up")["mrkt_tp"] == "001"
    assert _build_body("value", "kosdaq", "up")["mrkt_tp"] == "101"


def test_value_body_has_no_sort_tp():
    assert "sort_tp" not in _build_body("value", "all", "up")


# --- fetcher ---


def _fetcher(handler, *, now=_open_now) -> KiwoomRankingsFetcher:
    return KiwoomRankingsFetcher(
        _FakeTokenProvider(),  # type: ignore[arg-type]
        _transport=httpx.MockTransport(handler),
        _now=now,
    )


def test_fetch_sends_api_id_header_and_body():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=GOLDEN_CHANGE)

    fetcher = _fetcher(handler)
    snap = asyncio.run(fetcher.get("change", "kosdaq", "down"))
    assert snap.rows[0].change_pct == 29.97
    assert snap.market_open is True
    req = seen[0]
    assert req.headers["api-id"] == "ka10027"
    body = json.loads(req.content)
    assert body["mrkt_tp"] == "101"
    assert body["sort_tp"] == "3"  # down
    fetcher.close()


def test_ttl_cache_and_single_flight_hit_upstream_once():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=GOLDEN_CHANGE)

    fetcher = _fetcher(handler)

    async def scenario() -> None:
        a, b = await asyncio.gather(
            fetcher.get("change", "all", "up"), fetcher.get("change", "all", "up")
        )
        assert a.rows == b.rows
        await fetcher.get("change", "all", "up")  # 웜 캐시(TTL 내)

    asyncio.run(scenario())
    assert calls == 1
    fetcher.close()


def test_direction_splits_cache_key_for_change():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=GOLDEN_CHANGE)

    fetcher = _fetcher(handler)

    async def scenario() -> None:
        await fetcher.get("change", "all", "up")
        await fetcher.get("change", "all", "down")  # 다른 키 → 상류 재호출

    asyncio.run(scenario())
    assert calls == 2
    fetcher.close()


def test_non_trading_day_skips_upstream():
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json=GOLDEN_CHANGE)

    # 일요일 → is_trading_day False 경로. 캘린더 부재(None)면 거래일로 간주되므로,
    # is_trading_day 를 명시적으로 False 로 강제한다.
    fetcher = _fetcher(handler, now=lambda: datetime(2026, 7, 19, 10, 0, tzinfo=_KST))

    async def scenario() -> None:
        snap = await fetcher.get("change", "all", "up")
        assert snap.rows == ()
        assert snap.market_open is False

    import hoga.live.kiwoom_rankings as mod

    orig = mod.is_trading_day
    mod.is_trading_day = lambda d: False  # type: ignore[assignment]
    try:
        asyncio.run(scenario())
    finally:
        mod.is_trading_day = orig  # type: ignore[assignment]
    assert calls == 0
    fetcher.close()


def test_after_hours_trading_day_still_fetches_but_market_closed():
    """장 마감 후(트레이딩데이 저녁)엔 상류 조회는 하되 market_open=False."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=GOLDEN_CHANGE)

    # 월요일 16:00 — 거래일이지만 정규장 종료(15:30) 이후.
    fetcher = _fetcher(handler, now=lambda: datetime(2026, 7, 20, 16, 0, tzinfo=_KST))
    snap = asyncio.run(fetcher.get("change", "all", "up"))
    assert len(snap.rows) == 2  # 마감 순위 조회됨(저녁 복기)
    assert snap.market_open is False  # 폴링은 정지
    fetcher.close()


def test_error_return_code_raises_and_not_cached():
    bodies = [{"return_code": 3, "return_msg": "조회 실패"}, GOLDEN_CHANGE]

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=bodies.pop(0))

    fetcher = _fetcher(handler)

    async def scenario() -> None:
        with pytest.raises(KiwoomRankingsError):
            await fetcher.get("change", "all", "up")
        snap = await fetcher.get("change", "all", "up")  # 실패 미캐시 → 재시도 성공
        assert len(snap.rows) == 2

    asyncio.run(scenario())
    fetcher.close()


def test_http_error_raises():
    fetcher = _fetcher(lambda request: httpx.Response(500, text="boom"))
    with pytest.raises(KiwoomRankingsError):
        asyncio.run(fetcher.get("change", "all", "up"))
    fetcher.close()


# --- /api/live/rankings 라우트 ---


@pytest.fixture()
def _hermetic_kiwoom_env(monkeypatch):
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


def test_rankings_route_returns_rows(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    from hoga.live import api as live_api

    fetcher = _fetcher(lambda request: httpx.Response(200, json=GOLDEN_CHANGE))
    monkeypatch.setattr(live_api, "kiwoom_rankings_fetcher_instance", fetcher)
    r = _route_client(tmp_path).get("/api/live/rankings", params={"kind": "change", "market": "kosdaq", "direction": "down"})
    assert r.status_code == 200
    body = r.json()
    assert body["kind"] == "change"
    assert body["market"] == "kosdaq"
    assert body["rows"][0]["code"] == "294870"
    assert body["rows"][0]["change_pct"] == 29.97
    assert body["source"] == "kiwoom"
    fetcher.close()


def test_rankings_route_503_without_credentials(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    from hoga.live import api as live_api

    monkeypatch.setattr(live_api, "kiwoom_rankings_fetcher_instance", None)
    r = _route_client(tmp_path).get("/api/live/rankings", params={"kind": "change"})
    assert r.status_code == 503


def test_rankings_route_422_on_bad_kind(monkeypatch, tmp_path, _hermetic_kiwoom_env):
    r = _route_client(tmp_path).get("/api/live/rankings", params={"kind": "bogus"})
    assert r.status_code == 422
