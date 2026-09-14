from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import krx_close
from hoga.live.api import build_router
from hoga.live.krx_close import KrxCloseStore, auction_price
from hoga.util.timeenc import KST


def now(hour=17, minute=0):
    return datetime(2026, 9, 14, hour, minute, tzinfo=KST)


@pytest.fixture(autouse=True)
def trading_day(monkeypatch):
    monkeypatch.setattr(krx_close, "is_trading_session_today", lambda date: True)


def test_exact_auction_not_aftermarket_or_previous_date():
    rows = [
        {"cntr_tm": "20260914165800", "cur_prc": "-1692000"},
        {"cntr_tm": "20260914153000", "cur_prc": "-1697000"},
    ]
    assert auction_price(rows, "20260914153000") == 1697000
    assert auction_price(rows, "20260915153000") is None
    assert auction_price([{"cntr_tm": "20260914153000", "cur_prc": "0"}], "20260914153000") is None


@pytest.mark.asyncio
async def test_close_persists_after_restart(tmp_path):
    fetch = AsyncMock(return_value=[{"cntr_tm": "20260914153000", "cur_prc": "-1697000"}])
    first = await KrxCloseStore(tmp_path).get("000660", now(), fetch)
    second = await KrxCloseStore(tmp_path).get("000660", now(20), fetch)
    assert first == second
    assert second.price == 1697000
    fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_before_close_and_holiday_do_not_fetch(tmp_path, monkeypatch):
    fetch = AsyncMock()
    store = KrxCloseStore(tmp_path)
    assert (await store.get("000660", now(15, 30), fetch)).price is None
    monkeypatch.setattr(krx_close, "is_trading_session_today", lambda date: False)
    assert (await store.get("000660", now(), fetch)).price is None
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_missing_bar_retries_without_using_latest(tmp_path):
    fetch = AsyncMock(return_value=[{"cntr_tm": "20260914165900", "cur_prc": "123"}])
    store = KrxCloseStore(tmp_path)
    assert (await store.get("000660", now(), fetch)).price is None
    await store.get("000660", now(), fetch)
    fetch.assert_awaited_once()
    fetch.return_value = [{"cntr_tm": "20260914153000", "cur_prc": "1697000"}]
    assert (await store.get("000660", now(17, 2), fetch)).price == 1697000


def test_http_serializes_close_contract(tmp_path, monkeypatch):
    async def get(self, code, current, fetch):
        return krx_close.KrxCloseResponse(code=code, date="20260914", price=1697000, close_at_ms=123)
    monkeypatch.setattr(KrxCloseStore, "get", get)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=None))
    client = TestClient(app)
    response = client.get("/api/live/krx-close?code=000660")
    assert response.status_code == 200
    assert response.json() == {"code": "000660", "date": "20260914", "price": 1697000,
                               "close_at_ms": 123, "fetched_at_ms": None}
    assert client.get("/api/live/krx-close?code=000660_NX").status_code == 422


@pytest.mark.asyncio
async def test_unknown_calendar_requires_exact_today_row(tmp_path, monkeypatch):
    monkeypatch.setattr(krx_close, "is_trading_session_today", lambda date: None)
    fetch = AsyncMock(return_value=[{"cntr_tm": "20260914153000", "cur_prc": "1697000"}])
    assert (await KrxCloseStore(tmp_path).get("000660", now(), fetch)).price == 1697000


@pytest.mark.asyncio
async def test_special_close_metadata_and_date_rollover(tmp_path):
    from hoga.util.atomic_write import atomic_write_json

    atomic_write_json(tmp_path / "parquet/20260914/000660/hogaplay/meta.json",
                      {"regular_session_close_ms": 163000000})
    fetch = AsyncMock(return_value=[
        {"cntr_tm": "20260914153000", "cur_prc": "111"},
        {"cntr_tm": "20260914163000", "cur_prc": "222"},
    ])
    store = KrxCloseStore(tmp_path)
    assert (await store.get("000660", now(16), fetch)).price is None
    assert (await store.get("000660", now(), fetch)).price == 222
    tomorrow = datetime(2026, 9, 15, 17, tzinfo=KST)
    assert (await store.get("000660", tomorrow, fetch)).price is None


def test_http_queries_krx_raw_one_minute_only(tmp_path, monkeypatch):
    from hoga.live import api
    from hoga.live.kiwoom_rest import Page

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now()

    call = AsyncMock(return_value=Page(
        rows=[{"cntr_tm": "20260914153000", "cur_prc": "-1697000"},
              {"cntr_tm": "20260914165900", "cur_prc": "-1692000"}],
        cont=False, next_key="",
    ))

    class Client:
        pass

    client = Client()
    client.call = call

    async def run(scheduler, **kwargs):
        return await kwargs["fetch_fn"](client)

    monkeypatch.setattr(api, "datetime", Clock)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: client)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_scheduler", lambda data: None)
    monkeypatch.setattr(api.kiwoom_access, "run_with_capacity", run)
    monkeypatch.setattr(api.live_settings, "rest_bypass_enabled", lambda data: False)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    response = TestClient(app).get("/api/live/krx-close?code=000660")
    assert response.status_code == 200
    assert response.json()["price"] == 1697000
    call.assert_awaited_once_with("ka10080", {
        "stk_cd": "000660", "tic_scope": "1", "upd_stkpc_tp": "0",
    })
