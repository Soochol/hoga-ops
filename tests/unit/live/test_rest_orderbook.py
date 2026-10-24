import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import api, rest_orderbook
from hoga.live.api import build_router
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.live.rest_orderbook import RestOrderbookResponse, RestOrderbookStore, parse_book

EVIDENCE = json.loads((Path(__file__).parents[2] / "fixtures/kiwoom_rest/orderbook_weekend_456160.json").read_text())


def payload(index=0):
    return EVIDENCE["rows"][index]["body"]


@pytest.mark.parametrize(("index", "ask", "bid", "ask_qty", "bid_qty"), [
    (0, 49600, 49500, 43, 1), (1, 49550, 49500, 325, 3), (2, 49550, 49500, 325, 4),
])
def test_actual_weekend_ladders_without_invented_trading_date(index, ask, bid, ask_qty, bid_qty):
    book = parse_book(payload(index))
    assert book.ask[0].price == ask and book.ask[0].qty == ask_qty
    assert book.bid[0].price == bid and book.bid[0].qty == bid_qty
    assert len(book.ask) == len(book.bid) == 10
    assert book.book_time == "20:00:00"
    assert "ts_ms" not in book.model_dump()
    assert "date" not in book.model_dump()


def test_empty_and_partial_books_and_invalid_clock():
    assert parse_book({"bid_req_base_tm": "200000", "tot_buy_req": "100"}) is None
    book = parse_book({"buy_fpr_bid": "-1000", "buy_fpr_req": "0", "bid_req_base_tm": "246060"})
    assert book.ask[0].price == 0 and book.bid[0].price == 1000
    assert book.book_time is None


@pytest.mark.asyncio
async def test_shared_cache_expiry_and_venue_isolation(tmp_path, monkeypatch):
    clock = [1000]
    monkeypatch.setattr(rest_orderbook.time, "time", lambda: clock[0])
    store = RestOrderbookStore(tmp_path)
    fetch = AsyncMock(return_value=payload())
    first, same = await asyncio.gather(store.get("456160", "KRX", fetch), store.get("456160", "KRX", fetch))
    assert first == same
    fetch.assert_awaited_once()
    await store.get("456160", "KRX", fetch)
    fetch.assert_awaited_once()
    await store.get("456160", "NXT", fetch)
    assert fetch.await_count == 2
    clock[0] += 61
    await store.get("456160", "KRX", fetch)
    assert fetch.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", [False, True])
async def test_restart_empty_or_failed_read_preserves_exact_saved_book(tmp_path, failure):
    original = await RestOrderbookStore(tmp_path).get("456160", "KRX", AsyncMock(return_value=payload()))
    path = tmp_path / "last_rest_orderbook/456160-KRX.json"
    saved = path.read_bytes()
    fetch = AsyncMock(side_effect=RuntimeError("unavailable")) if failure else AsyncMock(return_value={})
    response = await RestOrderbookStore(tmp_path).get("456160", "KRX", fetch)
    assert response.book == original.book
    assert response.fetched_at_ms == original.fetched_at_ms
    assert response.source == "stored" and response.refresh_failed is failure
    assert path.read_bytes() == saved
    assert (await RestOrderbookStore(tmp_path).get("456160", "NXT", fetch)).book is None


@pytest.mark.asyncio
async def test_corrupt_file_failure_and_manual_recovery(tmp_path):
    path = tmp_path / "last_rest_orderbook/456160-KRX.json"
    path.parent.mkdir()
    path.write_text("broken")
    store = RestOrderbookStore(tmp_path)
    fetch = AsyncMock(side_effect=RuntimeError("unavailable"))
    response = await store.get("456160", "KRX", fetch)
    assert response.book is None and response.refresh_failed
    fetch.side_effect = None
    fetch.return_value = payload()
    assert (await store.get("456160", "KRX", fetch)).book is not None
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_save_failure_keeps_returned_book_and_retries(tmp_path, monkeypatch):
    def fail(*args):
        raise OSError("disk full")
    monkeypatch.setattr(rest_orderbook, "atomic_write_json", fail)
    fetch = AsyncMock(return_value=payload())
    store = RestOrderbookStore(tmp_path)
    response = await store.get("456160", "KRX", fetch)
    assert response.storage_failed and response.book is not None
    await store.get("456160", "KRX", fetch)
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_actual_rest_seam_uses_quote_read_path():
    class Token:
        def get_token(self):
            return "test-token"
    def handler(request):
        assert request.url.path == "/api/dostk/mrkcond"
        assert request.headers["api-id"] == "ka10004"
        assert json.loads(request.content) == {"stk_cd": "456160_NX"}
        return httpx.Response(200, json=payload(1))
    client = KiwoomRestClient(Token(), transport=httpx.MockTransport(handler))
    try:
        page = await client.call("ka10004", {"stk_cd": "456160_NX"})
        assert parse_book(page.raw).ask[0].price == 49550
    finally:
        await client.aclose()


def test_http_contract_and_capacity_wiring(tmp_path, monkeypatch):
    calls = []
    async def call(api_id, body):
        calls.append((api_id, body))
        return SimpleNamespace(raw=payload())
    client = SimpleNamespace(call=call)
    async def run(scheduler, **kwargs):
        assert kwargs["priority"] == "user_visible" and kwargs["api_id"] == "ka10004"
        return await kwargs["fetch_fn"](kwargs["client"])
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: client)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_scheduler", lambda data: None)
    monkeypatch.setattr(api.kiwoom_access, "run_with_capacity", run)
    monkeypatch.setattr(api.live_settings, "rest_bypass_enabled", lambda data: False)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    with TestClient(app) as http:
        response = http.get("/api/live/last-orderbook?code=456160&venue=NXT")
        assert response.status_code == 200
        result = response.json()
        assert RestOrderbookResponse.model_validate(result).model_dump() == result
        assert result["venue"] == "NXT" and result["source"] == "kiwoom_rest"
        assert result["book"]["ask"][0] == {"price": 49600, "qty": 43}
        assert result["book"]["book_time"] == "20:00:00"
        assert calls == [("ka10004", {"stk_cd": "456160_NX"})]
        assert http.get("/api/live/last-orderbook?code=456160&venue=NXT").json() == result
        assert http.get("/api/live/last-orderbook?code=456160&venue=other").status_code == 422
        assert http.get("/api/live/last-orderbook?code=456160_NX&venue=KRX").status_code == 422


def test_http_without_credentials_is_a_typed_failed_read(tmp_path, monkeypatch):
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: None)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    with TestClient(app) as http:
        response = http.get("/api/live/last-orderbook?code=456160&venue=KRX")
        assert response.status_code == 200
        assert response.json()["refresh_failed"] is True
        assert response.json()["book"] is None
