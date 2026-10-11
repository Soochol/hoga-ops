from __future__ import annotations

import asyncio
from datetime import datetime
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api import news_routes
from hoga.api.models import StockNewsResponse
from hoga.api.news_routes import StockNewsService, normalize_news
from hoga.live.kis_client import KisApiError, KisAuthError, KisRateLimitError
from hoga.live.kis_news_endpoints import KisNewsEndpointsMixin
from hoga.util.timeenc import KST


def row(serial="2026100822000239687", **fields):
    # 실측 field shape, 제목은 테스트용. 문서의 5슬롯 대신 실제 10슬롯을 받는다.
    return {
        "cntt_usiq_srno": serial, "news_ofer_entp_code": "2", "data_dt": "20261008",
        "data_tm": "220002", "hts_pbnt_titl_cntt": "테스트 뉴스 &amp; 제목", "dorg": "테스트신문",
        **{f"iscd{i}": "" for i in range(1, 11)}, **fields,
    }


def test_actual_shape_keeps_tenth_code_and_mismatched_articles():
    items = normalize_news([
        row(iscd10="005930"), row("other", iscd1="000810"), row("other", iscd1="000810"),
    ], None)
    assert len(items) == 2
    assert items[0].title == "테스트 뉴스 & 제목"
    assert items[0].related_codes == ["005930"]
    assert items[1].related_codes == ["000810"]
    expected = int(datetime(2026, 10, 8, 22, 0, 2, tzinfo=KST).timestamp() * 1000)
    assert items[0].published_at_ms == expected


def test_date_filters_previous_day_and_invalid_time_is_not_invented():
    items = normalize_news([row(data_dt="20261007"), row("short", data_tm="12")], "20261008")
    assert len(items) == 1
    assert items[0].published_at_ms is None
    with pytest.raises(ValueError):
        normalize_news([row(hts_pbnt_titl_cntt="")], None)


@pytest.mark.asyncio
async def test_endpoint_uses_shared_transport_and_verified_date_params():
    client = KisNewsEndpointsMixin()
    client._get = AsyncMock(return_value={"output": [row()]})
    assert await client.fetch_stock_news("005930", "20261007") == [row()]
    call = client._get.call_args.kwargs
    assert call["tr_id"] == "FHKST01011800"
    assert call["params"]["FID_INPUT_ISCD"] == "005930"
    assert call["params"]["FID_INPUT_DATE_1"] == "0020261007"
    assert call["params"]["FID_INPUT_HOUR_1"] == "0000235959"
    await client.fetch_stock_news("000660")
    assert client._get.call_args.kwargs["params"]["FID_INPUT_DATE_1"] == ""
    client._get.return_value = {"output": {}}
    with pytest.raises(ValueError):
        await client.fetch_stock_news("005930")


@pytest.mark.asyncio
async def test_cache_deduplicates_inflight_and_keeps_dates_separate(monkeypatch):
    clock = [0.0]
    monkeypatch.setattr(news_routes.time, "monotonic", lambda: clock[0])
    client = AsyncMock()
    client.fetch_stock_news.return_value = [row()]
    service = StockNewsService(lambda: client)
    first, second = await asyncio.gather(service.get("005930", None), service.get("005930", None))
    assert first == second
    assert client.fetch_stock_news.await_count == 1
    await service.get("005930", None)
    assert client.fetch_stock_news.await_count == 1
    await service.get("005930", "20261008")
    assert client.fetch_stock_news.await_count == 2
    clock[0] = 61
    await service.get("005930", None)
    assert client.fetch_stock_news.await_count == 3


@pytest.mark.asyncio
@pytest.mark.parametrize("error", [KisApiError("x", "secret"), KisAuthError("secret"), KisRateLimitError("secret")])
async def test_failure_retains_previous_success_without_leaking_error(monkeypatch, error):
    clock = [0.0]
    monkeypatch.setattr(news_routes.time, "monotonic", lambda: clock[0])
    client = AsyncMock()
    client.fetch_stock_news.return_value = [row()]
    service = StockNewsService(lambda: client)
    success = await service.get("005930", None)
    clock[0] = 61
    client.fetch_stock_news.side_effect = error
    stale = await service.get("005930", None)
    assert stale.status == "error"
    assert stale.items == success.items
    assert stale.fetched_at_ms == success.fetched_at_ms
    assert "secret" not in stale.model_dump_json()
    await service.get("005930", None)
    assert client.fetch_stock_news.await_count == 2  # 실패도 TTL을 지켜 재시도 폭주를 막는다.


def test_http_wire_empty_unconfigured_and_validation(monkeypatch, tmp_path):
    client = AsyncMock()
    client.fetch_stock_news.return_value = []
    factory = [client]
    monkeypatch.setattr(news_routes, "ensure_kis_client_for_account", lambda *_: factory[0])
    app = FastAPI()
    app.include_router(news_routes.build_router(data_dir=tmp_path))
    with TestClient(app) as http:
        success = http.get("/api/news/stock?code=005930").json()
        assert set(success) == {"code", "date", "status", "items", "fetched_at_ms", "limit"}
        assert success["status"] == "ok" and success["items"] == []
        assert StockNewsResponse.model_validate(success).model_dump(mode="json") == success
        factory[0] = None
        unconfigured = http.get("/api/news/stock?code=000660").json()
        assert unconfigured["status"] == "unconfigured"
        assert unconfigured["fetched_at_ms"] is None
        for query in ("code=bad", "code=005930&date=20260230", "code=005930&date=29990101"):
            assert http.get(f"/api/news/stock?{query}").status_code == 422


def test_http_serializes_full_rows_and_failed_first_request(monkeypatch, tmp_path):
    client = AsyncMock()
    client.fetch_stock_news.return_value = [row(iscd10="005930")]
    monkeypatch.setattr(news_routes, "ensure_kis_client_for_account", lambda *_: client)
    app = FastAPI()
    app.include_router(news_routes.build_router(data_dir=tmp_path))
    with TestClient(app) as http:
        data = http.get("/api/news/stock?code=005930").json()
        assert set(data["items"][0]) == {"id", "title", "source", "published_at_ms", "related_codes"}
        assert data["items"][0]["related_codes"] == ["005930"]
        assert StockNewsResponse.model_validate(data).model_dump(mode="json") == data
        client.fetch_stock_news.side_effect = KisAuthError("private error")
        failed = http.get("/api/news/stock?code=000660").json()
        assert failed["status"] == "error" and failed["items"] == []
        assert "private" not in str(failed)
