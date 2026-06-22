from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live.api import build_router
from hoga.live import lifecycle
from hoga.live.kis_client import IndexCandleFetchResult, InvestorNetFetchResult
from hoga.live.kis_models import IndexCandlePoint, InvestorNetPoint


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    return TestClient(app)


def test_live_indices_route_lists_only_enabled_representative_indices() -> None:
    res = _client().get("/api/live/indices")

    assert res.status_code == 200
    body = res.json()
    assert [row["id"] for row in body["indices"]] == [
        "KOSPI",
        "KOSDAQ",
        "KOSPI200",
        "KOSDAQ150",
        "KRX100",
    ]
    assert body["indices"][0]["kind"] == "index"
    assert body["indices"][0]["investor_scope"] == "market"
    assert all(row["id"] != "KRX300" for row in body["indices"])


def test_index_candles_rejects_stock_code_as_index_id(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=005930&timeframe=D&from=20260601&to=20260619",
    )
    assert res.status_code == 422


def test_index_candles_returns_fake_kis_daily_rows(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_daily_candles(self, index, from_s, to_s, *, period="D", foreground=False):
            assert index.id == "KOSPI"
            assert from_s == "20260601"
            assert to_s == "20260619"
            assert period == "D"
            assert foreground is True
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1,
                        open=2840.12,
                        high=2861.34,
                        low=2833.20,
                        close=2855.67,
                        volume=450000000,
                    ),
                ],
            )

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=D&from=20260601&to=20260619",
    )
    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["candles"] == [
        {
            "t_ms": 1,
            "open": 2840.12,
            "high": 2861.34,
            "low": 2833.2,
            "close": 2855.67,
            "volume": 450000000,
        },
    ]


def test_index_investor_net_returns_market_rows_for_kospi(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_market_investor_net(self, index, from_s, to_s):
            assert index.id == "KOSPI"
            assert from_s == "20260619"
            assert to_s == "20260619"
            return InvestorNetFetchResult(
                points=[
                    InvestorNetPoint(
                        t_ms=1,
                        foreign_net=-3519,
                        institution_net=17184,
                    ),
                ],
            )

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-investor-net?index_id=KOSPI&from=20260619&to=20260619",
    )

    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["points"] == [
        {"t_ms": 1, "foreign_net": -3519, "institution_net": 17184},
    ]


def test_index_investor_net_rejects_non_market_index(tmp_path) -> None:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-investor-net?index_id=KOSPI200&from=20260619&to=20260619",
    )

    assert res.status_code == 422
    assert res.json()["detail"]["code"] == "unsupported_index_investor_net"
