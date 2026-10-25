"""Replay recorded VIX prices through HTTP; no broker credentials or sockets."""

import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live.api import build_router
from hoga.live.us_index_minutes import NY, UsIndexMinuteService

EVIDENCE = Path(__file__).resolve().parents[2] / "docs/diagnostics/2026-10-25-vix/kis-live-probe.json"


def recorded():
    bodies = {p["kind"]: p["body"] for p in json.loads(EVIDENCE.read_text())["results"]}
    history = json.loads(EVIDENCE.with_name("daily-history-probe.json").read_text())
    rows = {r["stck_bsop_date"]: r for p in history["requests"] for r in p["body"]["output2"]
            if r.get("stck_bsop_date") not in (None, "", "00000000")}
    bodies["daily"]["output2"] = list(rows.values())
    return bodies


def test_vix_actual_prices_http_periods_compact_daily_and_shared_snapshot(tmp_path, monkeypatch):
    bodies = recorded()
    calls = []

    async def daily(code, start, end):
        assert code == "VIX"
        calls.append(("daily", start, end))
        return {**bodies["daily"], "output2": [r for r in bodies["daily"]["output2"]
                                                if start <= r["stck_bsop_date"] <= end]}

    async def minute(code):
        assert code == "VIX"
        calls.append(("minute",))
        return bodies["minute"]

    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_for_account", lambda *a: SimpleNamespace(
        get_global_index_daily_page=daily, get_global_index_minute_snapshot=minute))

    def forbidden(*a, **kw):
        pytest.fail("VIX must not enter domestic Kiwoom collection")

    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", forbidden)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    with TestClient(app) as client:
        catalog = client.get("/api/live/indices").json()["indices"]
        vix = next(i for i in catalog if i["id"] == "VIX")
        assert vix["market"] == "US" and vix["investor_scope"] == "none"
        url = "/api/live/index-candles?index_id=VIX&from=20260907&to=20261023"
        for tf, count in [("1m", 102), ("3m", 34), ("5m", 21), ("10m", 10),
                          ("15m", 7), ("30m", 3), ("60m", 1), ("D", 35)]:
            response = client.get(url + f"&timeframe={tf}")
            assert response.status_code == 200
            body = response.json()
            assert body["index_id"] == "VIX" and len(body["candles"]) == count
            assert body["candles"][-1]["close"] == 19.45
            assert body["candles"][-1]["trading_date"] == "20261023"
            if tf.endswith("m"):
                assert body["minute_metadata"]["history_scope"] == "latest_snapshot"
                assert body["minute_metadata"]["refresh_status"] == "normal"
                assert body["minute_metadata"]["refresh_interval_ms"] == 60_000
        assert calls.count(("minute",)) == 1
        full = client.get(url + "&timeframe=D").json()
        assert full["daily_metadata"]["refresh_status"] == "normal"
        compact = client.get(url + "&timeframe=D&daily_history_revision=" + full["daily_history_revision"]).json()
        assert compact["daily_history_unchanged"] is True
        assert compact["candles"] == full["candles"][-1:]
        for tf, count in [("W", 7), ("M", 2)]:
            body = client.get(url + f"&timeframe={tf}").json()
            assert len(body["candles"]) == count
            assert body["candles"][-1]["close"] == 19.45
            assert body["daily_metadata"]["refresh_status"] == "normal"
        header = client.get("/api/live/index-header-quote?index_id=VIX").json()
        assert header["value"] == 19.45 and header["previous_close"] == 19.03
        assert header["change"] == pytest.approx(0.42)
        assert header["delay_unverified"] is True
        assert calls.count(("minute",)) == 1
        assert client.get(url + "&timeframe=120m").status_code == 422
        assert client.get(url.replace("index-candles", "index-investor-net")).status_code == 422


@pytest.mark.asyncio
async def test_vix_actual_intraday_ohlc_and_shared_fast_polling():
    from datetime import datetime

    bodies = recorded()
    now = datetime(2026, 10, 23, 16, 16, tzinfo=NY)
    service = UsIndexMinuteService(wall_clock=now.timestamp)
    calls = []

    async def minute(code):
        calls.append(code)
        return bodies["minute"]

    client = SimpleNamespace(get_global_index_minute_snapshot=minute)
    bars, meta = await service.get("VIX", "1m", client=client)
    assert len(bars) == 102 and bars[-1].close == 19.45
    assert meta.refresh_interval_ms == 2000
    day = meta.current_daily_candle
    assert day and (day.open, day.high, day.low, day.close) == (19.18, 20.66, 18.87, 19.45)
    await service.get("VIX", "5m", client=client)
    assert calls == ["VIX"]
    await service.aclose()
