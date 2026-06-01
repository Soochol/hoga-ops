from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient
from hoga.live import lifecycle, api as live_api
from hoga.live.api import build_router, _market_phase, _KST
from hoga.live.kis_client import KisQuote


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


QUOTES = [KisQuote("005930", 72400, 1.2), KisQuote("000660", 183500, -0.8)]


def test_quotes_open_returns_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    assert r.status_code == 200
    body = r.json()
    assert body["phase"] == "open"
    assert body["quotes"][0] == {"code": "005930", "price": 72400, "change_pct": 1.2}
    assert body["quotes"][1]["change_pct"] == -0.8


def test_quotes_pre_open_nulls_change_pct(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "pre_open")
    c = TestClient(_app(QUOTES))
    r = c.get("/api/live/quotes", params={"codes": "005930,000660"})
    body = r.json()
    assert body["phase"] == "pre_open"
    assert all(q["change_pct"] is None for q in body["quotes"])
    assert body["quotes"][0]["price"] == 72400


def test_quotes_no_kis_graceful_empty(monkeypatch):
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    c = TestClient(_app(QUOTES, kis=False))
    r = c.get("/api/live/quotes", params={"codes": "005930"})
    assert r.status_code == 200
    assert r.json()["quotes"] == []


def test_quotes_filters_invalid_codes(monkeypatch):
    seen = {}
    class _Rec(_FakeKis):
        async def fetch_multi_price(self, codes): seen["codes"] = codes; return []
    monkeypatch.setattr(live_api, "_market_phase", lambda now: "open")
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, get_kis_client=lambda: _Rec([])))
    TestClient(app).get("/api/live/quotes", params={"codes": "005930,BADCODE,00066"})
    assert seen["codes"] == ["005930"]


def test_market_phase_boundary_at_0900_kst():
    # 장전(09:00 직전)=pre_open, 정각 09:00=open (반장도 오픈은 09:00 동일)
    assert _market_phase(datetime(2026, 6, 1, 8, 59, tzinfo=_KST)) == "pre_open"
    assert _market_phase(datetime(2026, 6, 1, 9, 0, tzinfo=_KST)) == "open"
    assert _market_phase(datetime(2026, 6, 1, 15, 30, tzinfo=_KST)) == "open"
