from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live import index_header_quote as header
from hoga.live.api import build_router
from hoga.live.index_registry import get_representative_index
from hoga.live.lifecycle import get_status
from hoga.live.us_daily_candles import NY, UsDailyBar, UsDailyMetadata, UsDateRange
from hoga.live.us_index_minutes import UsMinuteMetadata
from hoga.live.us_market_api import UsMarketApi
from hoga.util.timeenc import KST


def bar(day, value, clock="15:00:00"):
    stamp = datetime.fromisoformat(f"{day[:4]}-{day[4:6]}-{day[6:8]}T{clock}").replace(tzinfo=NY)
    return UsDailyBar(trading_date=day, t_ms=int(stamp.timestamp() * 1000),
                      open=value, high=value, low=value, close=value)


@pytest.mark.parametrize(("now", "expected"), [
    ("2026-07-31T08:59:00", ("20260730", "closed")),
    ("2026-07-31T09:00:00", ("20260731", "open")),
    ("2026-07-31T15:30:00", ("20260731", "closed")),
    ("2026-08-01T10:00:00", ("20260731", "closed")),
])
def test_domestic_calendar_session(now, expected):
    assert header.domestic_session(datetime.fromisoformat(now).replace(tzinfo=KST)) == expected


def test_domestic_calendar_unknown_is_not_a_weekday_guess(monkeypatch):
    from hoga.api.error_codes import UpstreamCode

    def unavailable(*_):
        raise header.calendar.TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_STALE)

    monkeypatch.setattr(header.calendar, "trading_days_in_range", unavailable)
    assert header.domestic_session(datetime(2026, 10, 22, 10, tzinfo=KST)) == (None, "unknown")


def test_domestic_last_good_keeps_successful_lookup_date():
    checked = int(datetime(2026, 7, 31, 16, tzinfo=KST).timestamp() * 1000)
    quote = SimpleNamespace(value=2650.35, change=32.46, change_rate=1.24, t_ms=checked)
    response = header.domestic_header_quote("KOSPI", quote, checked, "stale")
    assert response.trading_date == "20260731"
    assert response.previous_close == 2617.89
    assert response.observed_at_ms is None  # closed/sentinel lookup is not a trade timestamp
    assert response.refresh_status == "stale"


class FakeMarkets:
    def __init__(self, *, minutes=None, daily=None, missing=None, minute_status="normal"):
        self.minute_rows = minutes or [bar("20261021", 110)]
        self.daily_rows = daily or [bar("20261020", 100)]
        self.minute_meta = UsMinuteMetadata(refresh_status=minute_status, last_successful_check_at_ms=200)
        self.daily_meta = UsDailyMetadata(source="kis", price_basis="index_points", currency="index_points",
                                         session_scope="cash_index", missing=missing or [],
                                         last_successful_check_at_ms=100)

    async def index_minutes(self, *_):
        return self.minute_rows, self.minute_meta

    async def index_daily(self, *_):
        return self.daily_rows, self.daily_meta


@pytest.mark.asyncio
async def test_us_latest_minute_and_previous_daily_close_use_new_york_date():
    markets = FakeMarkets()
    response = await header.us_header_quote(get_representative_index("SP500"), markets,
                                           datetime(2026, 10, 21, 15, 1, tzinfo=NY))
    assert response.value == 110
    assert response.previous_close == 100
    assert response.change_rate == 10
    assert response.trading_date == "20261021"
    assert response.market_timezone == "America/New_York"
    assert response.source == "kis_minute"
    assert response.session_status == "open"


@pytest.mark.asyncio
async def test_us_completed_daily_wins_without_publishing_its_synthetic_time():
    markets = FakeMarkets(daily=[bar("20261020", 100), bar("20261021", 112)])
    response = await header.us_header_quote(get_representative_index("SOX"), markets,
                                           datetime(2026, 10, 22, 0, 10, tzinfo=NY))
    assert response.value == 112
    assert response.change_rate == 12
    assert response.observed_at_ms is None
    assert response.source == "kis_daily"
    assert response.session_status == "closed"


@pytest.mark.asyncio
async def test_us_missing_preceding_day_never_substitutes_an_older_close():
    markets = FakeMarkets(daily=[bar("20261019", 100)],
                          missing=[UsDateRange(start="20261020", end="20261020")])
    response = await header.us_header_quote(get_representative_index("SP500"), markets)
    assert response.value == 110
    assert response.previous_close is None
    assert response.change_rate is None
    assert response.refresh_status == "partial"


def test_us_header_http_serializes_shared_snapshots_and_retry(monkeypatch):
    markets = FakeMarkets()
    monkeypatch.setattr(UsMarketApi, "index_minutes", markets.index_minutes)
    monkeypatch.setattr(UsMarketApi, "index_daily", markets.index_daily)
    retries = []
    monkeypatch.setattr(UsMarketApi, "retry_index_quote", lambda self, index: retries.append(index.id))
    app = FastAPI()
    app.include_router(build_router(get_status=get_status))
    response = TestClient(app).get("/api/live/index-header-quote?index_id=SP500&retry=true")
    assert response.status_code == 200
    assert response.json()["previous_close"] == 100
    assert response.json()["index_id"] == "SP500"
    assert response.json()["market_timezone"] == "America/New_York"
    assert retries == ["SP500"]
