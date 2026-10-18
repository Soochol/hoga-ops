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
        assert client.get(url.replace("timeframe=D", "timeframe=120m")).status_code == 422
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


@pytest.mark.parametrize("index_id,code", [("NASDAQ_COMPOSITE", "COMP"), ("SP500", "SPX"), ("SOX", "SOX")])
@pytest.mark.parametrize("timeframe,aligned,count", [("W", "20240603", 2), ("M", "20240601", 1)])
def test_us_index_week_month_http_aggregates_shared_daily_history(
    tmp_path, monkeypatch, index_id, code, timeframe, aligned, count
):
    calls = []

    async def page(symbol, start, end):
        calls.append((symbol, start, end))
        rows = [
            dict(
                stck_bsop_date=day,
                ovrs_nmix_oprc="120.125",
                ovrs_nmix_hgpr="130.25",
                ovrs_nmix_lwpr="119.5",
                ovrs_nmix_prpr=str(121 + i / 10),
                acml_vol="0",
            )
            for i, day in enumerate(["20240603", "20240607", "20240610", "20240614"])
            if start <= day <= end
        ]
        return {"rt_cd": "0", "output2": rows}

    monkeypatch.setattr(
        "hoga.live.kis_runtime.ensure_kis_client_for_account",
        lambda *a: SimpleNamespace(get_global_index_daily_page=page),
    )
    with TestClient(app_for(tmp_path)) as client:
        url = f"/api/live/index-candles?index_id={index_id}&timeframe={timeframe}&from=20240605&to=20240616"
        response = client.get(url)
        assert response.status_code == 200
        body = response.json()
        assert body["timeframe"] == timeframe and body["from"] == aligned
        assert len(body["candles"]) == count
        assert body["candles"][0]["trading_date"] == "20240603"
        assert body["candles"][0]["open"] == 120.125
        assert body["candles"][-1]["close"] == 121.3
        assert not body["daily_metadata"]["missing"]
        assert body["daily_metadata"]["latest_bar_date"] == "20240614"
        assert all(symbol == code and start == aligned for symbol, start, _ in calls)
        before = len(calls)
        daily = client.get(f"/api/live/index-candles?index_id={index_id}&timeframe=D&from=20240603&to=20240616").json()
        assert len(daily["candles"]) == 4 and len(calls) == before


@pytest.mark.parametrize("timeframe,aligned,count", [("W", "20240603", 2), ("M", "20240601", 1)])
def test_us_stock_week_month_http_and_invalid_intraday(tmp_path, monkeypatch, timeframe, aligned, count):
    from hoga.live.candle_models import daily_anchor_ms
    from hoga.live.us_daily_candles import UsDailyBar, UsDateRange, UsFetchResult

    calls = []

    async def fetch(client, scheduler, exchange, symbol, start, end):
        calls.append((exchange, symbol, start, end))
        return UsFetchResult(
            bars=[
                UsDailyBar(
                    trading_date=day,
                    t_ms=daily_anchor_ms(day),
                    open=120.125,
                    high=130.25,
                    low=119.5,
                    close=121 + i / 10,
                    volume=10,
                )
                for i, day in enumerate(["20240603", "20240607", "20240610", "20240614"])
            ],
            completed=[UsDateRange(start=start, end=end)],
        )

    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda *a: object())
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_scheduler", lambda *a: object())
    monkeypatch.setattr("hoga.live.us_market_api.fetch_stock_daily", fetch)
    with TestClient(app_for(tmp_path)) as client:
        url = ("/api/live/us-stock-daily-candles?exchange=NYSE&symbol=BRKb"
               f"&from=20240605&to=20240616&timeframe={timeframe}")
        response = client.get(url)
        assert response.status_code == 200
        body = response.json()
        assert body["timeframe"] == timeframe and body["from"] == aligned
        assert body["symbol"] == "BRKb" and len(body["candles"]) == count
        assert body["candles"][-1]["close"] == 121.3
        assert body["daily_metadata"]["price_basis"] == "raw"
        assert calls == [("NYSE", "BRKb", aligned, "20240616")]
        assert client.get(url.replace(f"timeframe={timeframe}", "timeframe=1m")).status_code == 422


@pytest.mark.parametrize("index_id,code", [("NASDAQ_COMPOSITE", "COMP"), ("SP500", "SPX"), ("SOX", "SOX")])
def test_us_minute_http_latest_window_metadata_and_shared_cache(tmp_path, monkeypatch, index_id, code):
    calls = []

    async def snapshot(symbol):
        calls.append(symbol)
        return {"rt_cd": "0", "output2": [dict(stck_bsop_date="20261016", stck_cntg_hour="143500",
                optn_oprc="120", optn_hgpr="125", optn_lwpr="119", optn_prpr="120.888", cntg_vol="0")]}

    monkeypatch.setattr("hoga.live.kis_runtime.ensure_kis_client_for_account",
                        lambda *a: SimpleNamespace(get_global_index_minute_snapshot=snapshot))
    with TestClient(app_for(tmp_path)) as client:
        url = f"/api/live/index-candles?index_id={index_id}&timeframe=1m&from=20200101&to=20261018"
        response = client.get(url)
        assert response.status_code == 200
        result = response.json()
        assert result["from"] == result["to"] == "20261016"
        assert result["candles"][0]["close"] == 120.888
        assert result["candles"][0]["t_ms"] == 1792175700000
        assert "daily_metadata" not in result
        meta = result["minute_metadata"]
        assert meta["history_scope"] == "latest_snapshot" and meta["delay_status"] == "unverified"
        assert meta["refresh_status"] == "normal" and meta["available_from_ms"] == result["candles"][0]["t_ms"]
        assert client.get(url.replace("timeframe=1m", "timeframe=5m")).json()["candles"][0]["close"] == 120.888
        assert calls == [code]
        assert client.get(url.replace("timeframe=1m", "timeframe=240m")).status_code == 422
        stocks = client.get(
            "/api/live/us-stock-daily-candles?exchange=NASDAQ&symbol=AAPL&timeframe=1m&from=20260101&to=20261018"
        )
        assert stocks.status_code == 422


@pytest.mark.parametrize("exchange,symbol,vendor", [("NASDAQ", "NVDA", "ND"), ("NYSE", "BRKb", "NY"),
                                                   ("NYSE", "AHT_pd", "NY"), ("AMEX", "AAAA", "NA")])
def test_us_stock_minute_http_preserves_identity_native_prices_and_timestamps(tmp_path, monkeypatch,
                                                                          exchange, symbol, vendor):
    calls = []

    async def call(api_id, payload, **kw):
        calls.append((api_id, payload, kw))
        rows = [dict(cntr_tm="20261015261000", bus_dt="20261015", cur_prc="213.8314", open_pric="213.83",
                     high_pric="214", low_pric="213.77", trde_qty="7079", upd_stkpc_tp="1f", upd_rt="")]
        return Page(rows=rows, cont=False, next_key="", raw={"return_code": 0, "result_list": rows})

    fake = SimpleNamespace(call=call)
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda *a: fake)
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_scheduler", lambda *a: object())

    async def run(scheduler, **kw):
        return await kw["fetch_fn"](fake)

    monkeypatch.setattr("hoga.live.kiwoom_access.run_with_capacity", run)
    with TestClient(app_for(tmp_path)) as client:
        url = f"/api/live/us-stock-minute-candles?exchange={exchange}&symbol={symbol}&timeframe=5m"
        response = client.get(url)
        assert response.status_code == 200
        body = response.json()
        assert body["instrument_key"] == f"us-stock:{exchange}:{symbol}"
        assert body["timeframe"] == "5m" and "daily_metadata" not in body
        assert body["from"] == body["to"] == "20261015"
        candle = body["candles"][0]
        assert candle["close"] == 213.8314 and candle["volume"] == 7079
        assert candle["t_ms"] == 1792131000000  # Oct 16 02:10 New York / 06:10 UTC
        meta = body["minute_metadata"]
        assert meta["source"] == "kiwoom" and meta["currency"] == "USD"
        assert meta["history_scope"] == "bounded_recent_window" and meta["bar_limit"] == 800
        assert meta["delay_status"] == "unverified" and meta["refresh_status"] == "normal"
        assert meta["pages_fetched"] == 1 and not meta["more_available"]
        assert client.get(url).json() == body and len(calls) == 1
        assert calls[0][0] == "usa06011" and calls[0][1]["stex_tp"] == vendor
        assert calls[0][1]["stk_cd"] == symbol and calls[0][1]["tic_scope"] == "5"
        for tf in ["1s", "120m", "D"]:
            assert client.get(url.replace("timeframe=5m", f"timeframe={tf}")).status_code == 422
        assert client.get(url.replace(symbol, "bad:ticker")).status_code == 422


@pytest.mark.parametrize("bypass,status", [(False, "unconfigured"), (True, "bypass")])
def test_us_stock_minute_unconfigured_and_bypass_are_typed(tmp_path, monkeypatch, bypass, status):
    monkeypatch.setattr("hoga.live.kiwoom_rest_runtime.ensure_rest_client", lambda *a: None)
    monkeypatch.setattr("hoga.live.us_market_api.UsMarketApi.bypass", lambda self: bypass)
    with TestClient(app_for(tmp_path)) as client:
        response = client.get("/api/live/us-stock-minute-candles?exchange=NASDAQ&symbol=NVDA&timeframe=1m")
        assert response.status_code == 200
        body = response.json()
        assert body["candles"] == [] and body["minute_metadata"]["refresh_status"] == status
        assert body["minute_metadata"]["available_from_ms"] is None
        assert body["minute_metadata"]["last_successful_check_at_ms"] is None
