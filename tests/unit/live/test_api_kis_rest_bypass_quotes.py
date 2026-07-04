from __future__ import annotations

import datetime

from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.models import LiveSettingsResponse
from hoga.live import api as live_api
from hoga.live import kis_runtime, lifecycle
from hoga.live.api import build_router
from hoga.live.buffer import LiveBuffer
from hoga.live.kis_client import InvestorNetFetchResult, KisQuote
from hoga.live.kis_models import InvestorNetPoint, InvestorTrendEstimateRow
from hoga.live.settings import save_live_settings
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


class _CountingKis:
    def __init__(self) -> None:
        self.quote_fetch_count = 0
        self.investor_net_fetch_count = 0
        self.index_investor_net_fetch_count = 0
        self.investor_trend_estimate_fetch_count = 0

    async def fetch_multi_price(self, codes, *, venue="KRX"):
        self.quote_fetch_count += 1
        quotes = {
            "005930": KisQuote(
                "005930",
                70_000,
                1.2,
                800,
                open=69_500,
                high=70_500,
                low=69_000,
            )
        }
        return [quotes[code] for code in codes if code in quotes]

    async def fetch_investor_net(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        self.investor_net_fetch_count += 1
        return InvestorNetFetchResult(points=[], violations=[])

    async def fetch_market_investor_net(
        self,
        index,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
    ) -> InvestorNetFetchResult:
        self.index_investor_net_fetch_count += 1
        return InvestorNetFetchResult(
            points=[InvestorNetPoint(t_ms=1, foreign_net=1, institution_net=2)],
            violations=[],
        )

    async def fetch_investor_trend_estimate(self, code: str):
        self.investor_trend_estimate_fetch_count += 1
        return [InvestorTrendEstimateRow(slot="0900", foreign_qty=1, institution_qty=2, sum_qty=3)]


def _app(tmp_path, fake_kis: _CountingKis, *, get_buffer=None) -> FastAPI:
    lifecycle.reset_for_tests()
    kis_runtime.set_kis_client(fake_kis)  # type: ignore[arg-type]
    app = FastAPI()
    app.include_router(
        build_router(
            get_status=lifecycle.get_status,
            get_buffer=get_buffer,
            data_dir=tmp_path,
        )
    )
    return app


def _forbid_run_with_capacity(monkeypatch) -> dict[str, int]:
    calls = {"count": 0}

    async def fake_run_with_capacity(*_args, **_kwargs):
        calls["count"] += 1
        raise AssertionError("run_with_capacity must not be called during KIS REST bypass")

    monkeypatch.setattr("hoga.live.kis_access.run_with_capacity", fake_run_with_capacity)
    return calls


def test_quotes_bypass_returns_stale_last_good_without_fetch(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _CountingKis()
    app = _app(tmp_path, fake)

    with TestClient(app, raise_server_exceptions=False) as client:
        seed = client.get("/api/live/quotes?codes=005930&venue=KRX")
        assert seed.status_code == 200
        assert seed.json()["quotes"][0]["price"] == 70_000

        save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
        before = fake.quote_fetch_count
        run_with_capacity_calls = _forbid_run_with_capacity(monkeypatch)
        response = client.get("/api/live/quotes?codes=005930&venue=KRX")

    assert response.status_code == 200
    body = response.json()
    assert body["quotes"][0]["code"] == "005930"
    assert body["quotes"][0]["stale"] is True
    assert body["quotes"][0]["stale_reason"] == "kis_rest_bypassed"
    assert fake.quote_fetch_count == before
    assert run_with_capacity_calls["count"] == 0


def test_quotes_bypass_returns_empty_without_last_good(tmp_path, monkeypatch) -> None:
    fake = _CountingKis()
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    app = _app(tmp_path, fake)
    run_with_capacity_calls = _forbid_run_with_capacity(monkeypatch)

    with TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/api/live/quotes?codes=005930&venue=KRX")

    assert response.status_code == 200
    assert response.json()["quotes"] == []
    assert fake.quote_fetch_count == 0
    assert run_with_capacity_calls["count"] == 0


def test_tab_metrics_bypass_keeps_hoga_fields_without_quote_enrichment(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(live_api, "_quote_phase", lambda now, venue_policy="KRX": "open")
    fake = _CountingKis()
    buf = LiveBuffer()
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    app = _app(tmp_path, fake, get_buffer=lambda: buf)
    run_with_capacity_calls = _forbid_run_with_capacity(monkeypatch)

    async def seed_orderbook() -> None:
        await buf.publish(
            "005930",
            [
                LiveSnapshot(
                    t_ms=int(datetime.datetime.now(live_api._KST).timestamp() * 1000),
                    kind=SnapshotKind.OB,
                    payload={"total_bid_qty": 132, "total_ask_qty": 100, "phase": "regular"},
                )
            ],
            now_ms=int(datetime.datetime.now(live_api._KST).timestamp() * 1000),
        )

    with TestClient(app, raise_server_exceptions=False) as client:
        assert client.portal is not None
        client.portal.call(seed_orderbook)
        response = client.get("/api/live/tab-metrics?codes=005930&venue=KRX")

    assert response.status_code == 200
    assert response.json()["metrics"] == [
        {
            "code": "005930",
            "change_pct": None,
            "hoga_ratio_x": 1.32,
            "hoga_available": True,
            "hoga_reason": None,
            "source": "live",
        }
    ]
    assert fake.quote_fetch_count == 0
    assert run_with_capacity_calls["count"] == 0


def test_investor_routes_bypass_degrade_without_kis_capacity(
    tmp_path,
    monkeypatch,
) -> None:
    fake = _CountingKis()
    save_live_settings(tmp_path, LiveSettingsResponse(kis_rest_bypass_enabled=True))
    app = _app(tmp_path, fake)
    run_with_capacity_calls = _forbid_run_with_capacity(monkeypatch)

    with TestClient(app, raise_server_exceptions=False) as client:
        trend = client.get("/api/live/investor-trend-estimate?code=005930")
        past = client.get("/api/live/past-investor-net?code=005930&from=20240101&to=20240105")
        index = client.get("/api/live/index-investor-net?index_id=KOSPI&from=20260619&to=20260619")

    assert trend.status_code == 200
    trend_body = trend.json()
    assert trend_body["rows"] == []
    assert trend_body["status"] == "error"
    assert trend_body["data_warning"]["reason"] == "kis_rest_bypassed"

    assert past.status_code == 200
    past_body = past.json()
    assert past_body["points"] == []
    assert past_body["fresh_batches"] == []
    assert past_body["data_warnings"][0]["reason"] == "kis_rest_bypassed"

    assert index.status_code == 200
    index_body = index.json()
    assert index_body["points"] == []
    assert index_body["data_warnings"][0]["reason"] == "kis_rest_bypassed"

    assert run_with_capacity_calls["count"] == 0
    assert fake.investor_net_fetch_count == 0
    assert fake.index_investor_net_fetch_count == 0
    assert fake.investor_trend_estimate_fetch_count == 0
