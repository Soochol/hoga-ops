"""옵션 심리 API 테스트 (ADR-0135).

네트워크를 타지 않는다 — 런타임 싱글턴에 스냅샷을 직접 심고 라우트가 그것을
어떻게 조립하는지만 본다. 핵심 검증은 **계층 배분**이다: 곡선은 전수에서,
ATM IV/RR 만 ATM 계층에서 와야 한다.
"""
from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.sentiment_routes import build_router
from hoga.live.kis_option_endpoints import OptionChainSnapshot, OptionQuote
from hoga.live.option_sentiment_runtime import get_runtime, reset_runtime_for_tests


@pytest.fixture(autouse=True)
def _isolate_runtime(monkeypatch):
    """런타임 싱글턴 격리 + 실제 KIS 접속 차단.

    라우트가 백그라운드 수집 루프를 띄우므로, 개발 머신의 .env 에 자격증명이 있으면
    테스트가 진짜로 마스터를 내려받고 780종목을 조회한다. 팩토리를 None 으로 막으면
    루프 자체가 뜨지 않는다(runtime.request 의 조기 반환).
    """
    reset_runtime_for_tests()
    monkeypatch.setattr(
        "hoga.api.sentiment_routes.ensure_kis_client_for_account",
        lambda *a, **k: None,
    )
    yield
    reset_runtime_for_tests()


def _app(tmp_path) -> FastAPI:
    """라우터만 조립한다 — ``default_app()`` 을 쓰면 안 된다.

    ``default_app()`` 은 ``load_env()`` 를 호출해 저장소의 **진짜 .env** 를
    os.environ 에 밀어 넣는다. 이 머신의 .env 에는 KIS 계정이 4개 들어 있어서,
    뒤이어 도는 ``test_configured_account_ids_two`` 가 KIS_APP_KEY/_2 만 설정했는데도
    ``[0, 1, 2, 3]`` 을 보고 깨졌다(단독 실행은 통과 — 순서 의존 오염).
    conftest 의 autouse 가드들이 같은 이유로 .mst 다운로드와 .env 재로드를 막는다.
    """
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    return app


def _q(right, strike, *, oi=0, volume=0, iv=0.0, delta=0.0, gamma=0.0) -> OptionQuote:
    return OptionQuote(
        code=f"{'B' if right == 'call' else 'C'}{int(strike)}",
        right=right, strike=strike, price=1.0, volume=volume, open_interest=oi,
        oi_change=0, iv=iv, delta=delta, gamma=gamma, vega=0.0, theta=0.0,
    )


def _snap(quotes, *, underlying=110.0) -> OptionChainSnapshot:
    return OptionChainSnapshot(
        expiry="202608", underlying=underlying,
        quotes=tuple(quotes), dropped=0, t_ms=0,
    )


def test_cold_start_reports_warming_not_error(tmp_path) -> None:
    # 첫 전수 수집은 실측 ~60초 걸린다. 그 사이를 에러로 표시하면 UI 가
    # "설정이 잘못됐다" 로 안내하게 된다 — 구분이 필요하다.
    client = TestClient(_app(tmp_path))
    body = client.get("/api/sentiment/option").json()
    assert body["unavailable"] in ("warming", "kis_credentials_missing")
    assert body["put_call"] is None


def test_full_snapshot_drives_all_indicators(tmp_path) -> None:
    client = TestClient(_app(tmp_path))
    client.get("/api/sentiment/option")  # 런타임 싱글턴 생성

    rt = get_runtime(lambda: None)
    rt._full = _snap([
        _q("call", 100.0, oi=10, volume=100, iv=15.0, delta=0.9, gamma=0.01),
        _q("call", 110.0, oi=20, volume=200, iv=14.0, delta=0.25, gamma=0.02),
        _q("put", 100.0, oi=30, volume=300, iv=20.0, delta=-0.25, gamma=0.01),
        _q("put", 110.0, oi=20, volume=100, iv=16.0, delta=-0.5, gamma=0.02),
    ])
    rt._full_at = 1_700_000_000_000
    rt._expiry = "202608"

    body = client.get("/api/sentiment/option").json()
    assert body["unavailable"] is None
    assert body["expiry"] == "202608"
    assert body["full_as_of_ms"] == 1_700_000_000_000
    # P/C 는 전수 기준 — 거래량 (300+100)/(100+200)
    assert body["put_call"]["volume_ratio"] == pytest.approx(400 / 300)
    assert body["put_call"]["oi_ratio"] == pytest.approx(50 / 30)
    assert body["oi_distribution"]["max_pain"] is not None
    assert len(body["iv_skew"]["points"]) == 2
    # 25델타 RR = 풋(20.0) − 콜(14.0)
    assert body["iv_skew"]["risk_reversal_25d"] == pytest.approx(6.0)


def test_atm_layer_overrides_only_atm_iv_not_the_curve(tmp_path) -> None:
    client = TestClient(_app(tmp_path))
    client.get("/api/sentiment/option")
    rt = get_runtime(lambda: None)
    rt._full = _snap([
        _q("call", 100.0, oi=10, iv=15.0, delta=0.25),
        _q("call", 110.0, oi=20, iv=14.0, delta=0.5),
        _q("put", 100.0, oi=30, iv=20.0, delta=-0.25),
        _q("put", 110.0, oi=20, iv=16.0, delta=-0.5),
    ])
    rt._full_at = 1_000
    # ATM 창은 행사가 110 하나뿐 — 곡선을 여기서 만들면 스마일이 잘린다.
    rt._atm = _snap([
        _q("call", 110.0, oi=20, iv=99.0, delta=0.25),
        _q("put", 110.0, oi=20, iv=111.0, delta=-0.25),
    ])
    rt._atm_at = 2_000
    rt._expiry = "202608"

    body = client.get("/api/sentiment/option").json()
    # 곡선은 전수(행사가 2개)를 유지해야 한다
    assert [p["strike"] for p in body["iv_skew"]["points"]] == [100.0, 110.0]
    # ATM IV·RR 만 ATM 계층 값으로 교체
    assert body["iv_skew"]["atm_iv"] == pytest.approx(105.0)  # (99 + 111) / 2
    assert body["iv_skew"]["risk_reversal_25d"] == pytest.approx(12.0)  # 111 − 99
    # 두 계층의 시각이 각각 보여야 한다
    assert body["full_as_of_ms"] == 1_000
    assert body["atm_as_of_ms"] == 2_000
