from datetime import date, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.api.calendar import TradingDayUnavailableError
from hoga.api.error_codes import UpstreamCode
from hoga.live import api, krx_previous_close
from hoga.live.api import build_router
from hoga.live.candle_fetch_result import DailyCandleFetchResult
from hoga.live.candle_models import LiveCandle, daily_anchor_ms
from hoga.live.krx_previous_close import KrxPreviousCloseStore
from hoga.util.timeenc import KST


def now():
    return datetime(2026, 10, 15, 10, tzinfo=KST)


def result(day="20261014", close=220000):
    return DailyCandleFetchResult(candles=[LiveCandle(
        t_ms=daily_anchor_ms(day), open=close, high=close, low=close, close=close, volume=1,
    )])


@pytest.fixture(autouse=True)
def calendar(monkeypatch):
    monkeypatch.setattr(
        krx_previous_close, "trading_days_in_range", lambda start, end: ["20261013", "20261014", "20261015"],
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(("reference", "days", "expected"), [
    (date(2026, 10, 19), ["20261015", "20261016", "20261019"], "20261016"),
    (date(2026, 10, 6), ["20260930", "20261002", "20261006"], "20261002"),
    (date(2026, 10, 18), ["20261015", "20261016"], "20261015"),
])
async def test_previous_session_skips_weekends_and_holidays(tmp_path, monkeypatch, reference, days, expected):
    monkeypatch.setattr(krx_previous_close, "trading_days_in_range", lambda start, end: days)
    fetch = AsyncMock(return_value=result(expected))
    response = await KrxPreviousCloseStore(tmp_path).get("005930", reference, now(), fetch)
    assert response.session_date == days[-1]
    assert response.date == expected
    assert response.price == 220000
    fetch.assert_awaited_once_with(expected)


@pytest.mark.asyncio
async def test_persists_exact_raw_close_and_shares_requests(tmp_path):
    import asyncio

    fetch = AsyncMock(return_value=result())
    store = KrxPreviousCloseStore(tmp_path)
    first, second = await asyncio.gather(*[
        store.get("005930", now().date(), now(), fetch) for _ in range(2)
    ])
    restarted = await KrxPreviousCloseStore(tmp_path).get("005930", now().date(), now(), fetch)
    assert first == second == restarted
    assert first.price == 220000
    fetch.assert_awaited_once()


@pytest.mark.asyncio
async def test_missing_exact_day_does_not_use_older_close_and_retries(tmp_path):
    fetch = AsyncMock(return_value=result("20261013", 111111))
    store = KrxPreviousCloseStore(tmp_path)
    assert (await store.get("005930", now().date(), now(), fetch)).price is None
    assert (await store.get("005930", now().date(), now(), fetch)).price is None
    fetch.assert_awaited_once()
    fetch.return_value = result()
    assert (await store.get("005930", now().date(), now() + timedelta(minutes=2), fetch)).price == 220000


@pytest.mark.asyncio
async def test_rollover_fetches_new_previous_session(tmp_path, monkeypatch):
    store = KrxPreviousCloseStore(tmp_path)
    fetch = AsyncMock(return_value=result())
    first = await store.get("005930", now().date(), now(), fetch)
    monkeypatch.setattr(
        krx_previous_close, "trading_days_in_range", lambda start, end: ["20261014", "20261015", "20261016"],
    )
    fetch.return_value = result("20261015", 225000)
    second = await store.get("005930", date(2026, 10, 16), now() + timedelta(days=1), fetch)
    assert first.date == "20261014"
    assert second.date == "20261015"
    assert second.price == 225000


@pytest.mark.asyncio
async def test_unknown_calendar_does_not_guess_weekdays(tmp_path, monkeypatch):
    def unavailable(start, end):
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_STALE)
    monkeypatch.setattr(krx_previous_close, "trading_days_in_range", unavailable)
    fetch = AsyncMock()
    response = await KrxPreviousCloseStore(tmp_path).get("005930", now().date(), now(), fetch)
    assert response.price is None
    assert response.date is None
    fetch.assert_not_awaited()


def test_http_uses_krx_unadjusted_daily_adapter_and_capacity(tmp_path, monkeypatch):
    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now()

    client = object()
    calls = []

    async def fetch_daily(client_arg, code, frm, to, **kwargs):
        calls.append((client_arg, code, frm, to, kwargs))
        await kwargs["run_page"](AsyncMock(), 0)
        return result()

    async def run(scheduler, **kwargs):
        assert kwargs["api_id"] == "ka10081"
        assert kwargs["priority"] == "user_visible"
        assert kwargs["key"] == ("krx-previous-close", "005930", "20261014", 0)
        return await kwargs["fetch_fn"](kwargs["client"])

    monkeypatch.setattr(api, "datetime", Clock)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_rest_client", lambda data: client)
    monkeypatch.setattr(api.kiwoom_rest_runtime, "ensure_scheduler", lambda data: None)
    monkeypatch.setattr(api.kiwoom_daily_candles, "fetch_daily_candles", fetch_daily)
    monkeypatch.setattr(api.kiwoom_access, "run_with_capacity", run)
    monkeypatch.setattr(api.live_settings, "rest_bypass_enabled", lambda data: False)
    app = FastAPI()
    app.include_router(build_router(get_status=lambda: None, data_dir=tmp_path))
    http = TestClient(app)
    response = http.get("/api/live/krx-previous-close?code=005930&as_of=20261015")
    assert response.status_code == 200
    assert response.json()["price"] == 220000
    assert response.json()["date"] == "20261014"
    assert calls[0][:4] == (client, "005930", "20261014", "20261014")
    assert calls[0][4]["venue"] == "KRX"
    assert calls[0][4]["adjust"] is False
    assert calls[0][4]["adjusted_as_of"] is None
    assert http.get("/api/live/krx-previous-close?code=005930_NX&as_of=20261015").status_code == 422
    assert http.get("/api/live/krx-previous-close?code=005930&as_of=20260230").status_code == 422
    assert http.get("/api/live/krx-previous-close?code=005930&as_of=20261016").status_code == 422
