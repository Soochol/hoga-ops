import asyncio
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import heatmap, watchlist
from hoga.api.watchlist_projection import capture_ordered_codes
from hoga.api.watchlist_routes import build_router as watchlist_router
from hoga.live import lifecycle
from hoga.live.api import build_router
from hoga.live.kiwoom_rest import Page
from hoga.live.us_market_api import UsMarketApi


def app_for(data_dir):
    app = FastAPI()
    app.include_router(build_router(get_status=lifecycle.get_status, data_dir=data_dir))
    return app


@pytest.mark.parametrize("index_id,code", [("NASDAQ_COMPOSITE", "COMP"), ("SP500", "SPX"), ("SOX", "SOX")])
def test_us_index_http_preserves_dates_decimals_metadata_and_routes_only_to_kis(tmp_path, monkeypatch, index_id, code):
    calls = []

    async def page(symbol, start, end):
        calls.append((symbol, start, end))
        rows = (
            []
            if end < "20240607"
            else [
                dict(
                    stck_bsop_date="20240607",
                    ovrs_nmix_oprc="120.0",
                    ovrs_nmix_hgpr="125.0",
                    ovrs_nmix_lwpr="119.0",
                    ovrs_nmix_prpr="120.8880",
                    acml_vol="0",
                )
            ]
        )
        return {"rt_cd": "0", "output2": rows}

    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda *a: SimpleNamespace(get_global_index_daily_page=page),
    )

    def forbidden(*a, **kw):
        pytest.fail("US index must never call Kiwoom")

    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", forbidden)
    with TestClient(app_for(tmp_path)) as client:
        url = f"/api/live/index-candles?index_id={index_id}&timeframe=D&from=20240601&to=20240610"
        body = client.get(url).json()
        assert body["candles"][0]["close"] == 120.888
        assert body["candles"][0]["trading_date"] == "20240607"
        assert body["daily_metadata"]["source"] == "kis"
        assert body["daily_metadata"]["market_timezone"] == "America/New_York"
        assert not body["daily_metadata"]["missing"]
        assert all(c[0] == code for c in calls)
        before = len(calls)
        assert client.get(url).json() == body
        assert len(calls) == before
        assert client.get(url.replace("timeframe=D", "timeframe=1m")).status_code == 422
        assert client.get(url.replace("index-candles", "index-investor-net")).status_code == 422


def test_unconfigured_us_stock_is_typed_and_never_calls_domestic_api(tmp_path, monkeypatch):
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda *a: None)
    with TestClient(app_for(tmp_path)) as client:
        result = client.get("/api/live/us-stock-daily-candles?exchange=NYSE&symbol=BRK.B&from=20240601&to=20240610")
        assert result.status_code == 200
        body = result.json()
        assert body["instrument_key"] == "us-stock:NYSE:BRK.B"
        for ticker in ("BRKb", "AHT_pd"):
            case = client.get(
                f"/api/live/us-stock-daily-candles?exchange=NYSE&symbol={ticker}&from=20240601&to=20240610"
            )
            assert case.status_code == 200 and case.json()["symbol"] == ticker
        assert body["daily_metadata"]["refresh_status"] == "unconfigured"
        assert body["daily_metadata"]["missing"] == [{"start": "20240601", "end": "20240610"}]
        assert body["daily_metadata"]["price_basis"] == "raw"
        assert (
            client.get(
                "/api/live/us-stock-daily-candles?exchange=NASDAQ&symbol=AAPL&from=20240601&to=99991231"
            ).status_code
            == 422
        )
        assert body["daily_metadata"]["session_scope"] == "vendor_daily_unverified"
        assert (
            client.get(
                "/api/live/us-stock-daily-candles?exchange=UNKNOWN&symbol=AAPL&from=20240601&to=20240610"
            ).status_code
            == 422
        )
        assert (
            client.get(
                "/api/live/us-stock-daily-candles?exchange=NYSE&symbol=../bad&from=20240601&to=20240610"
            ).status_code
            == 422
        )


@pytest.mark.asyncio
async def test_master_singleflight_caches_real_exchange_mapping_and_keeps_last_good(tmp_path, monkeypatch):
    calls = []
    fail = [False]
    gate = asyncio.Event()

    async def call(*args, **kwargs):
        calls.append(args)
        await gate.wait()
        if fail[0]:
            raise ValueError("temporary malformed master")
        rows = [dict(stex_tp="NY", stk_cd="BRKb", stk_nm="버크셔", stk_enm="Berkshire", isEtf="N")]
        return Page(rows=rows, cont=False, next_key="", raw={"return_code": 0, "list": rows})

    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda *a: SimpleNamespace(call=call))
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_scheduler", lambda *a: object())

    async def run(scheduler, *, client, fetch_fn, **kwargs):
        return await fetch_fn(client)

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    api = UsMarketApi(tmp_path)
    a = asyncio.create_task(api.catalog())
    b = asyncio.create_task(api.catalog())
    await asyncio.sleep(0)
    gate.set()
    first, second = await asyncio.gather(a, b)
    assert first == second and len(calls) == 1
    assert first.stocks[0].exchange == "NYSE" and first.stocks[0].symbol == "BRKb"
    assert (await api.catalog()).stocks == first.stocks
    assert len(calls) == 1
    api.master_expiry = 0
    fail[0] = True
    stale = await api.catalog()
    assert stale.status == "stale" and stale.stocks == first.stocks
    assert stale.fetched_at_ms == first.fetched_at_ms


def test_us_favorites_roundtrip_and_stay_out_of_capture_and_heatmap_seed(tmp_path, monkeypatch):
    async def no_refresh(**kwargs):
        pass

    monkeypatch.setattr("hoga.api.watchlist_routes.refresh_live_stream", no_refresh)
    app = FastAPI()
    app.include_router(watchlist_router(data_dir=tmp_path))
    with TestClient(app) as client:
        folder = client.post("/api/watchlist/folders", json={"name": "미국"}).json()
        folder_id = folder["id"]
        added = client.post(
            f"/api/watchlist/folders/{folder_id}/members",
            json={"code": "us-stock:NYSE:BRK.B", "name": "버크셔 해서웨이"},
        )
        assert added.status_code == 201
        assert added.json()["name"] == "버크셔 해서웨이"
        assert client.get("/api/watchlist").json()["entries"][0]["code"] == "us-stock:NYSE:BRK.B"
        assert not capture_ordered_codes(watchlist.load_document(tmp_path))
        assert not watchlist.load_watchlist(tmp_path)
        heatmap.seed_from_watchlist_if_absent(tmp_path)
        assert not heatmap.load_document(tmp_path).entries
        assert client.post("/api/watchlist/us-stock:NYSE:BRK.B/catchup").status_code == 422
        assert client.delete(f"/api/watchlist/folders/{folder_id}/members/us-stock:NYSE:BRK.B").status_code == 204
