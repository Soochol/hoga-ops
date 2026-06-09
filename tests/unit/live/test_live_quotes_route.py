from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from hoga.live import kis_runtime, lifecycle, api as live_api
from hoga.live.api import build_router, _quote_phase, _KST
from hoga.live.kis_client import KisQuote


@pytest.fixture(autouse=True)
def _hermetic_kis_env(monkeypatch):
    """배경 /quotes 라우트는 data_dir 배선 시 kis_for_role → configured_account_ids로
    ambient env를 읽는다(계정 분리 2026-06-09). 실제 creds export/load_env 오염으로부터
    격리(N=0 → account 0 폴백) + 프로세스 전역 KisClient dict 리셋(라우트가 dict를 읽으므로
    교차 테스트 누수 방지). N=2 라우팅 테스트만 명시적으로 setenv."""
    for _k in ("KIS_APP_KEY", "KIS_APP_SECRET", "KIS_APP_KEY_2", "KIS_APP_SECRET_2"):
        monkeypatch.delenv(_k, raising=False)
    lifecycle.reset_for_tests()


class _FakeKis:
    def __init__(self, quotes): self._quotes = quotes
    async def fetch_multi_price(self, codes): return self._quotes


def _app(quotes, kis=True):
    fake = _FakeKis(quotes) if kis else None
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=(lambda: fake),
    ))
    return app


QUOTES = [KisQuote("005930", 72400, 1.2, 750), KisQuote("000660", 183500, -0.8, -1500)]


def test_quotes_open_returns_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "open"
    assert body["quotes"][0] == {"code": "005930", "price": 72400, "change_pct": 1.2, "change_won": 750}
    assert body["quotes"][1]["change_pct"] == -0.8
    assert body["quotes"][1]["change_won"] == -1500


def test_quotes_pre_open_nulls_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "pre_open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r.json()
    assert body["phase"] == "pre_open"
    assert all(q["change_pct"] is None for q in body["quotes"])
    assert all(q["change_won"] is None for q in body["quotes"])
    assert body["quotes"][0]["price"] == 72400


def test_quotes_no_kis_graceful_empty(monkeypatch):
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    c = TestClient(_app(QUOTES, kis=False))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []


def test_quotes_filters_invalid_codes(monkeypatch):
    seen = {}
    class _Rec(_FakeKis):
        async def fetch_multi_price(self, codes): seen["codes"] = codes; return []
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, get_kis_client=lambda: _Rec([])))
    TestClient(app).get("/api/live/quotes", params={"codes": "005930,BADCODE,00066"})
    assert seen["codes"] == ["005930"]


def test_quotes_lazy_inits_kis_when_singleton_absent(monkeypatch, tmp_path):
    # _kis_client singleton never seeded (empty watchlist + no-gap day) but the
    # route is wired with data_dir → it resolves a client from env on demand
    # instead of silently returning empty quotes (code-review #2).
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    fake = _FakeKis(QUOTES)
    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", lambda data_dir: fake)
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=lambda: None,   # singleton absent
        data_dir=tmp_path,
    ))
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert [q["code"] for q in r.json()["quotes"]] == ["005930", "000660"]


def test_quotes_no_lazy_init_without_data_dir(monkeypatch):
    # Without data_dir wired, a None singleton stays graceful-empty and the
    # resolver is never invoked (no accidental client construction).
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    calls = {"n": 0}

    def _resolver(data_dir):
        calls["n"] += 1

    monkeypatch.setattr(kis_runtime, "ensure_kis_client_from_env", _resolver)
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, get_kis_client=lambda: None))
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []
    assert calls["n"] == 0  # data_dir None → resolver never called


def test_quote_phase_boundary_at_0900_kst():
    # 장전(09:00 직전)=pre_open, 정각 09:00=open (반장도 오픈은 09:00 동일)
    assert _quote_phase(datetime(2026, 6, 1, 8, 59, tzinfo=_KST)) == "pre_open"
    assert _quote_phase(datetime(2026, 6, 1, 9, 0, tzinfo=_KST)) == "open"
    assert _quote_phase(datetime(2026, 6, 1, 15, 30, tzinfo=_KST)) == "open"


def test_quote_phase_clock_boundaries_closed():
    """스펙 2026-06-08 ⑧: 평일 08:50–16:00만 폴링 가치 구간. KRX 동시호가
    08:50 시작(사용자 정정 — 구 08:30 아님). 2026-06-08은 월요일."""
    mk = lambda h, m: datetime(2026, 6, 8, h, m, tzinfo=_KST)  # noqa: E731
    assert _quote_phase(mk(8, 49)) == "closed"
    assert _quote_phase(mk(8, 50)) == "pre_open"
    assert _quote_phase(mk(9, 0)) == "open"
    assert _quote_phase(mk(15, 59)) == "open"
    assert _quote_phase(mk(16, 0)) == "closed"
    # 토요일(2026-06-13) 장중 시각도 closed
    assert _quote_phase(datetime(2026, 6, 13, 10, 0, tzinfo=_KST)) == "closed"


class _CountingFakeKis:
    def __init__(self, quotes):
        self._quotes = quotes
        self.calls = 0

    async def fetch_multi_price(self, codes):
        self.calls += 1
        return self._quotes


def _counting_app(fake):
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=(lambda: fake),
    ))
    return app


def test_quotes_closed_serves_last_seen_without_kis(monkeypatch):
    """closed에는 장중 마지막 시세를 KIS 무호출로 서빙('마지막 시세 유지' 결정,
    스펙 2026-06-08 ⑧). 등락률은 open과 동일하게 표시(종가+등락 — pre_open과
    다름)."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r1.json()["quotes"][0]["price"] == 72400
    assert fake.calls == 1
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "closed")
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r2.json()
    assert fake.calls == 1, "closed에서 캐시 보유 코드에 KIS 호출 발생"
    assert body["phase"] == "closed"
    assert body["quotes"][0]["price"] == 72400
    assert body["quotes"][0]["change_pct"] == 1.2   # closed는 등락률 유지
    assert body["quotes"][1]["change_won"] == -1500


def test_quotes_closed_cold_start_fetches_once(monkeypatch):
    """closed 콜드 스타트(서버 재시작 직후): 캐시 미스면 정확히 1회만 KIS를
    불러 채우고(KIS는 장외에도 종가 반환), 이후 요청은 캐시 서빙."""
    fake = _CountingFakeKis(QUOTES)
    c = TestClient(_counting_app(fake))
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "closed")
    r1 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1
    assert r1.json()["quotes"][0]["price"] == 72400
    r2 = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert fake.calls == 1, "콜드 스타트 이후에도 KIS 재호출"
    assert r2.json()["quotes"][1]["price"] == 183500


def _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1):
    monkeypatch.setenv("KIS_APP_KEY", "k0")
    monkeypatch.setenv("KIS_APP_SECRET", "s0")
    monkeypatch.setenv("KIS_APP_KEY_2", "k1")
    monkeypatch.setenv("KIS_APP_SECRET_2", "s1")
    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake0, 0)
    kis_runtime.set_kis_client(fake1, 1)
    app = FastAPI()
    app.include_router(build_router(
        get_status=lifecycle.get_status,
        get_kis_client=kis_runtime.get_kis_client,
        data_dir=tmp_path,
    ))
    return app


def test_quotes_routes_background_to_account1(monkeypatch, tmp_path):
    """N=2 정상: /quotes(배경 폴링)가 account 1(유휴였던 REST 버킷)을 쓴다 — account 0 무호출."""
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    monkeypatch.setattr("hoga.live.lifecycle.degraded_account_ids", lambda: set())
    fake0, fake1 = _CountingFakeKis(QUOTES), _CountingFakeKis(QUOTES)
    app = _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1)
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert fake1.calls == 1, "background /quotes가 account 1을 쓰지 않음"
    assert fake0.calls == 0, "account 0(foreground 전용)이 background에 침범"


def test_quotes_account1_degraded_falls_back_to_account0(monkeypatch, tmp_path):
    """N=2이지만 account 1 저하 → /quotes가 account 0로 폴백."""
    monkeypatch.setattr(live_api, "_quote_phase", lambda now: "open")
    monkeypatch.setattr("hoga.live.lifecycle.degraded_account_ids", lambda: {1})
    fake0, fake1 = _CountingFakeKis(QUOTES), _CountingFakeKis(QUOTES)
    app = _two_account_quotes_app(tmp_path, monkeypatch, fake0, fake1)
    r = TestClient(app).get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    assert fake0.calls == 1, "degraded인데 account 0로 폴백 안 됨"
    assert fake1.calls == 0, "degraded account 1을 그대로 사용"
