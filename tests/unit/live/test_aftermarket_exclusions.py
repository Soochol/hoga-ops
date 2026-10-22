import asyncio
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import aftermarket_exclusions as module, api
from hoga.live.aftermarket_exclusions import AftermarketExclusionService, parse_exclusion_reasons
from hoga.live.kiwoom_rest import KiwoomRestClient
from hoga.util.timeenc import KST

NOW = int(datetime(2026, 10, 22, 19, 30, tzinfo=KST).timestamp() * 1000)


@pytest.fixture(autouse=True)
def clock(monkeypatch):
    monkeypatch.setattr(module, "is_trading_day", lambda date: True)
    monkeypatch.setattr(module.time, "time", lambda: NOW / 1000)


@pytest.mark.parametrize(("row", "expected"), [
    ({"marketCode": "8", "orderWarning": "1"}, ["etf"]),
    ({"marketCode": "70"}, ["etn"]),
    ({"orderWarning": "2"}, ["liquidation"]),
    ({"orderWarning": "3"}, ["short_term_overheat"]),
    ({"orderWarning": "4"}, ["investment_risk"]),
    ({"orderWarning": "5", "state": "증거금100%|투자경고"}, ["investment_warning"]),
    ({"state": "관리종목|증거금100%", "auditInfo": "투자주의환기종목"},
     ["administrative", "investment_caution_issue"]),
    ({"state": "초저유동종목|이상급등종목"}, ["low_liquidity", "abnormal_surge"]),
    ({"state": "투자유의종목", "marketCode": "0"}, ["investment_caution"]),
    ({"state": "투자유의종목", "marketCode": "10"}, []),
    ({"state": "투자주의|투자경고지정예고|투자경고해제|증거금100%", "auditInfo": "정상", "orderWarning": "0"}, []),
    ({"state": "거래정지|단기과열예고|투자주의환기해제"}, []),
    ({"state": None, "orderWarning": "999", "nxtEnable": "N"}, []),
])
def test_only_confirmed_exclusions_are_interpreted(row, expected):
    assert parse_exclusion_reasons(row) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize(("code", "product"), [("069500", "etf"), ("Q500001", "etn")])
async def test_products_require_no_broker_and_keep_request_identity(code, product):
    fetch = AsyncMock()
    service = AftermarketExclusionService(fetch, lambda code: product)
    result = await service.get(code, NOW)
    assert result.code == code
    assert result.reasons == [product]
    assert result.source == "symbol_master"
    fetch.assert_not_awaited()


@pytest.mark.asyncio
async def test_shares_views_and_rechecks_designation_release_without_using_expired_flags(monkeypatch):
    fetch = AsyncMock(return_value={"code": "079650", "orderWarning": "5"})
    service = AftermarketExclusionService(fetch, lambda code: "stock")
    first, second = await asyncio.gather(service.get("079650", NOW), service.get("079650", NOW))
    assert first == second
    assert first.reasons == ["investment_warning"]
    fetch.assert_awaited_once_with("079650")
    monotonic = module.time.monotonic()
    monkeypatch.setattr(module.time, "monotonic", lambda: monotonic + 61)
    fetch.side_effect = httpx.ConnectError("private provider details")
    failed = await service.get("079650", NOW + 61_000)
    assert failed.status == "error"
    assert failed.reasons == []
    monkeypatch.setattr(module.time, "monotonic", lambda: monotonic + 122)
    fetch.side_effect = None
    fetch.return_value = {"code": "079650", "orderWarning": "0", "auditInfo": "정상"}
    released = await service.get("079650", NOW + 122_000)
    assert released.status == "checked"
    assert released.reasons == []  # Not proof of complete eligibility.


@pytest.mark.asyncio
async def test_date_rollover_and_code_changes_do_not_share_restrictions():
    fetch = AsyncMock(side_effect=lambda code: {"code": code, "orderWarning": "5" if code == "079650" else "0"})
    service = AftermarketExclusionService(fetch, lambda code: "stock")
    assert (await service.get("079650", NOW)).reasons == ["investment_warning"]
    assert (await service.get("005930", NOW)).reasons == []
    assert (await service.get("079650", NOW + 86_400_000)).date == "20261023"
    assert fetch.await_count == 3


@pytest.mark.asyncio
async def test_unconfigured_and_wrong_code_responses_do_not_infer_restrictions():
    fetch = AsyncMock(return_value=None)
    service = AftermarketExclusionService(fetch, lambda code: None)
    assert (await service.get("079650", NOW)).status == "unavailable"
    fetch.return_value = {"code": "079650", "orderWarning": "5"}
    result = await service.get("005930", NOW)
    assert result.status == "error"
    assert result.reasons == []


@pytest.mark.asyncio
async def test_a_six_character_stock_code_starting_with_q_is_not_an_etn_prefix():
    fetch = AsyncMock(return_value={"code": "Q00001", "orderWarning": "0"})
    result = await AftermarketExclusionService(fetch, lambda code: None).get("Q00001", NOW)
    assert result.status == "checked"
    fetch.assert_awaited_once_with("Q00001")


@pytest.mark.asyncio
@pytest.mark.parametrize("offset", [-4 * 3_600_000, 30 * 60_000, 2 * 86_400_000])
async def test_no_broker_lookup_outside_aftermarket(offset):
    fetch = AsyncMock()
    result = await AftermarketExclusionService(fetch, lambda code: "stock").get("079650", NOW + offset)
    assert result.status == "inactive"
    fetch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(("trading", "status"), [(False, "inactive"), (None, "unavailable")])
async def test_holiday_and_unknown_calendar_do_not_claim_current_restrictions(monkeypatch, trading, status):
    monkeypatch.setattr(module, "is_trading_day", lambda date: trading)
    fetch = AsyncMock()
    result = await AftermarketExclusionService(fetch, lambda code: "etf").get("069500", NOW)
    assert result.status == status
    assert result.reasons == []
    fetch.assert_not_awaited()


def test_http_uses_current_broker_metadata_through_governor_and_preserves_wire(tmp_path, monkeypatch):
    client = SimpleNamespace(call=AsyncMock(return_value=SimpleNamespace(rows=[{
        "code": "079650", "marketCode": "10", "state": "증거금100%", "orderWarning": "5",
    }])))
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: client)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_scheduler", lambda data: None)
    monkeypatch.setattr(api.live_settings, "rest_bypass_enabled", lambda data: False)
    async def run(scheduler, **kwargs):
        assert kwargs["api_id"] == "ka10100"
        assert kwargs["key"] == ("aftermarket-exclusion", "079650")
        return await kwargs["fetch_fn"](kwargs["client"])
    monkeypatch.setattr(api.kiwoom_access, "run_with_capacity", run)
    app = FastAPI()
    app.include_router(api.build_router(lambda: None, data_dir=tmp_path))
    with TestClient(app) as http:
        result = http.get("/api/live/aftermarket-exclusion?code=079650")
        assert result.status_code == 200
        assert result.json() == {"code": "079650", "date": "20261022", "status": "checked",
            "reasons": ["investment_warning"], "checked_at_ms": NOW, "source": "kiwoom_ka10100"}
        assert http.get("/api/live/aftermarket-exclusion?code=../bad").status_code == 422
    client.call.assert_awaited_once_with("ka10100", {"stk_cd": "079650"})


def test_http_product_exclusions_work_without_credentials_and_unknown_keeps_null_fields(tmp_path, monkeypatch):
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: None)
    monkeypatch.setattr(api.symbols, "search", lambda code: [SimpleNamespace(
        code=code, security_type="etf" if code == "069500" else "stock",
    )])
    app = FastAPI()
    app.include_router(api.build_router(lambda: None, data_dir=tmp_path))
    with TestClient(app) as http:
        product = http.get("/api/live/aftermarket-exclusion?code=069500").json()
        assert product == {"code": "069500", "date": "20261022", "status": "checked", "reasons": ["etf"],
            "checked_at_ms": NOW, "source": "symbol_master"}
        unknown = http.get("/api/live/aftermarket-exclusion?code=079650").json()
        assert unknown == {"code": "079650", "date": "20261022", "status": "unavailable", "reasons": [],
            "checked_at_ms": None, "source": None}


@pytest.mark.asyncio
async def test_ka10100_flat_response_keeps_designation_fields():
    body = {"return_code": 0, "return_msg": "정상", "code": "079650", "orderWarning": "5",
        "auditInfo": "정상", "state": "증거금100%", "marketCode": "10"}
    class Provider:
        def get_token(self):
            return "test-token"
    provider = Provider()
    client = KiwoomRestClient(provider, transport=httpx.MockTransport(lambda request: httpx.Response(200, json=body)))
    try:
        page = await client.call("ka10100", {"stk_cd": "079650"})
        assert page.rows[0]["orderWarning"] == "5"
        assert parse_exclusion_reasons(page.rows[0]) == ["investment_warning"]
    finally:
        await client.aclose()
