from datetime import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api as live_api
from hoga.live.api import build_router
from hoga.live import lifecycle
from hoga.live.kis_client import KIS_KST, IndexCandleFetchResult, InvestorNetFetchResult
from hoga.live.kis_models import IndexCandlePoint, InvestorNetPoint


def _daily_t_ms(day: str) -> int:
    dt = datetime(
        int(day[:4]),
        int(day[4:6]),
        int(day[6:8]),
        15,
        30,
        tzinfo=KIS_KST,
    )
    return int(dt.timestamp() * 1000)


def _client() -> TestClient:
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status))
    return TestClient(app)


def _patch_kis_capacity(monkeypatch, fake_kis):
    scheduler = object()
    calls = []
    monkeypatch.setattr(live_api, "ensure_kis_capacity_scheduler", lambda data_dir: scheduler)
    monkeypatch.setattr(live_api.kis_access, "has_rest_capacity", lambda data_dir: True)

    async def fake_run_with_capacity(
        scheduler_arg,
        *,
        data_dir,
        key,
        endpoint,
        priority,
        fetch_fn,
        cooldown_scope=None,
    ):
        calls.append({
            "scheduler": scheduler_arg,
            "data_dir": data_dir,
            "key": key,
            "endpoint": str(endpoint),
            "priority": priority,
            "cooldown_scope": cooldown_scope,
        })
        return await fetch_fn(fake_kis)

    monkeypatch.setattr(live_api.kis_access, "run_with_capacity", fake_run_with_capacity)
    return scheduler, calls


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
                        t_ms=_daily_t_ms("20260619"),
                        open=2840.12,
                        high=2861.34,
                        low=2833.20,
                        close=2855.67,
                        volume=450000000,
                    ),
                ],
            )

    scheduler, calls = _patch_kis_capacity(monkeypatch, FakeKis())

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
            "t_ms": _daily_t_ms("20260619"),
            "open": 2840.12,
            "high": 2861.34,
            "low": 2833.2,
            "close": 2855.67,
            "volume": 450000000,
        },
    ]
    assert calls == [{
        "scheduler": scheduler,
        "data_dir": tmp_path,
        "key": ("index-daily", "KOSPI", "D", "20260601", "20260619"),
        "endpoint": "index-daily",
        "priority": "user_visible",
        "cooldown_scope": ("index-daily", "KOSPI", "D"),
    }]


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
                        t_ms=_daily_t_ms(from_s),
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

    _patch_kis_capacity(monkeypatch, FakeKis())
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

    scheduler, calls = _patch_kis_capacity(monkeypatch, FakeKis())

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
    assert calls == [{
        "scheduler": scheduler,
        "data_dir": tmp_path,
        "key": ("index-minute", "KOSPI", "1m", 60, "20260619", "20260619"),
        "endpoint": "index-minute",
        "priority": "user_visible",
        "cooldown_scope": ("index-minute", "KOSPI", "1m"),
    }]


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

    _patch_kis_capacity(monkeypatch, FakeKis())
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


def test_index_minute_candles_warn_when_request_starts_before_returned_depth(tmp_path, monkeypatch) -> None:
    class FakeKis:
        async def fetch_index_minute_candles(self, index, from_s, to_s, *, bucket_seconds=60, foreground=False):
            assert from_s == "20260601"
            assert to_s == "20260622"
            return IndexCandleFetchResult(
                candles=[
                    IndexCandlePoint(
                        t_ms=1782103980000,
                        open=1.0,
                        high=1.0,
                        low=1.0,
                        close=1.0,
                        volume=1,
                    ),
                ],
                violations=[],
            )

    _patch_kis_capacity(monkeypatch, FakeKis())
    monkeypatch.setattr(live_api, "index_minute_candles_cache_instance", None, raising=False)

    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=tmp_path))
    res = TestClient(app).get(
        "/api/live/index-candles?index_id=KOSPI&timeframe=1m&from=20260601&to=20260622",
    )

    assert res.status_code == 200
    assert any(
        w["reason"] == "index_minute_depth_limited"
        and w["date"] == "20260622"
        for w in res.json()["data_warnings"]
    )


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

    _patch_kis_capacity(monkeypatch, FakeKis())

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
