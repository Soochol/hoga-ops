from datetime import datetime

import pytest

from hoga.live.index_registry import get_representative_index
from hoga.live.us_daily_candles import NY, UsDailyMetadata, UsDateRange, parse_bar
from hoga.live.us_index_minutes import UsMinuteMetadata
from hoga.live.us_market_api import UsMarketApi


def candle(day, op=100, hi=110, lo=90, close=105):
    return parse_bar(dict(day=day, op=op, hi=hi, lo=lo, close=close),
                     fields=("day", "op", "hi", "lo", "close", "volume"))


@pytest.mark.asyncio
@pytest.mark.parametrize("timeframe", ["D", "W", "M"])
async def test_current_day_uses_vendor_full_session_ohlc_without_promoting_coverage(timeframe):
    api = UsMarketApi(None)
    api.daily.calendar_now = lambda: datetime(2026, 10, 22, 11, tzinfo=NY)
    base = [candle("20261021")]
    day = candle("20261022", 106, 200, 80, 121)
    meta = UsDailyMetadata(source="kis", price_basis="index_points", currency="index_points",
                           session_scope="cash_index", latest_bar_date="20261021",
                           completed=[UsDateRange(start="20261001", end="20261021")])
    coverage = list(meta.completed)
    api.daily.verified_coverage = lambda _: list(coverage)

    async def history(*_):
        return base, meta

    async def minutes(*_):
        return [], UsMinuteMetadata(current_daily_candle=day, refresh_interval_ms=2000)

    api.index_daily, api.index_minutes = history, minutes
    bars, daily_meta, minute_meta = await api.index_calendar_chart(
        get_representative_index("SOX"), "20261001", "20261022", timeframe)
    expected_open = 106 if timeframe == "D" else 100
    assert (bars[-1].open, bars[-1].high, bars[-1].low, bars[-1].close) == (expected_open, 200, 80, 121)
    assert minute_meta.refresh_interval_ms == 2000
    assert daily_meta.latest_bar_date == "20261021"
    assert coverage == meta.completed and coverage[-1].end == "20261021"
    assert base == [candle("20261021")]
    # A validated completed daily close wins over the provisional snapshot.
    api.daily.calendar_now = lambda: datetime(2026, 10, 22, 17, tzinfo=NY)
    base.append(candle("20261022", close=108))
    coverage.append(UsDateRange(start="20261022", end="20261022"))
    bars, _, _ = await api.index_calendar_chart(get_representative_index("SOX"), "20261001", "20261022", timeframe)
    assert bars[-1].close == 108


@pytest.mark.asyncio
async def test_historical_calendar_never_requests_live_snapshot():
    api = UsMarketApi(None)
    api.daily.calendar_now = lambda: datetime(2026, 10, 22, 11, tzinfo=NY)

    async def history(*_):
        return [], None

    async def forbidden(*_):
        pytest.fail("historical calendar must not demand live quotes")

    api.index_daily, api.index_minutes = history, forbidden
    result = await api.index_calendar_chart(get_representative_index("SP500"), "20260101", "20261021", "M")
    assert result == ([], None, None)


@pytest.mark.asyncio
@pytest.mark.parametrize("timeframe", ["W", "M"])
async def test_provisional_day_never_fills_missing_history_in_calendar_bucket(timeframe):
    api = UsMarketApi(None)
    api.daily.calendar_now = lambda: datetime(2026, 10, 22, 11, tzinfo=NY)
    api.daily.verified_coverage = lambda _: [UsDateRange(start="20261021", end="20261021")]

    async def history(*_):
        return [candle("20261021")], UsDailyMetadata(source="kis", price_basis="index_points",
            currency="index_points", session_scope="cash_index", refresh_status="partial")

    async def minutes(*_):
        return [], UsMinuteMetadata(current_daily_candle=candle("20261022"))

    api.index_daily, api.index_minutes = history, minutes
    bars, meta, _ = await api.index_calendar_chart(get_representative_index("SP500"), "20261001", "20261022", timeframe)
    assert bars == [] and meta.refresh_status == "partial"
