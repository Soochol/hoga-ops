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


def test_index_daily_candles_reuses_cached_newer_range_for_broader_scrollback(
    tmp_path,
    monkeypatch,
) -> None:
    calls: list[tuple[str, str]] = []

    class FakeKis:
        async def fetch_index_daily_candles(self, index, from_s, to_s, *, period="D", foreground=False):
            calls.append((from_s, to_s))
            close = float(len(calls))
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=int(from_s),
                        open=close,
                        high=close,
                        low=close,
                        close=close,
                        volume=1,
                    ),
                ],
            )

    async def no_windowing(from_s, to_s, period, fetch_batch, *, max_concurrency=3):
        return await fetch_batch(from_s, to_s)

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())
    monkeypatch.setattr(live_api, "fetch_index_daily_candles_windowed", no_windowing, raising=False)
    monkeypatch.setattr(live_api, "index_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)
    r1 = client.get(
        "/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20250101&to=20251231",
    )
    r2 = client.get(
        "/api/live/index-candles?index_id=KOSDAQ&timeframe=D&from=20240101&to=20251231",
    )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls == [
        ("20250101", "20251231"),
        ("20240101", "20241231"),
    ]
    assert [c["close"] for c in r2.json()["candles"]] == [2.0, 1.0]


def test_index_candles_returns_fake_kis_minute_rows(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            assert index.id == "KOSPI"
            assert from_s == "20260619"
            assert to_s == "20260619"
            assert bucket_seconds == 60
            assert foreground is True
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1781829000000,
                        open=2850.10,
                        high=2852.34,
                        low=2849.87,
                        close=2851.67,
                        volume=123456,
                    ),
                ],
            )

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260619&to=20260619",
    )
    assert res.status_code == 200
    body = res.json()
    assert body["index_id"] == "KOSPI"
    assert body["timeframe"] == "1m"
    assert body["candles"] == [
        {
            "t_ms": 1781829000000,
            "open": 2850.10,
            "high": 2852.34,
            "low": 2849.87,
            "close": 2851.67,
            "volume": 123456,
        },
    ]


def test_index_minute_candles_repeated_request_uses_cache(tmp_path, monkeypatch) -> None:
    calls = 0

    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            nonlocal calls
            calls += 1
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1782103980000,
                        open=1.0,
                        high=1.0,
                        low=1.0,
                        close=float(calls),
                        volume=1,
                    ),
                ],
                violations=[],
            )

    monkeypatch.setattr(live_api.kis_access, "kis_for_role", lambda role, data_dir: FakeKis())
    monkeypatch.setattr(live_api, "index_minute_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    client = TestClient(app)

    r1 = client.get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622",
    )
    r2 = client.get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260622&to=20260622",
    )

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert calls == 1
    assert r2.json()["candles"][0]["close"] == 1.0


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
