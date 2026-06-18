"""Tests for hoga.live.past_daily_candles_cache (memory-only daily cache)."""
from __future__ import annotations

import time
from datetime import date
from unittest.mock import patch

from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _bar(t_ms: int) -> dict:
    return {"t_ms": t_ms, "open": 100, "high": 110, "low": 95, "close": 105, "volume": 10}


def test_empty_code_returns_no_batches() -> None:
    cache = PastDailyCandlesCache()
    assert cache.list_batches("005930") == []


def test_append_and_read_round_trip() -> None:
    cache = PastDailyCandlesCache()
    bars = [_bar(1000), _bar(2000)]
    cache.append_batch("005930", date(2024, 1, 1), date(2024, 12, 31), bars)
    out = cache.list_batches("005930")
    assert len(out) == 1
    b_from, b_to, b_bars = out[0]
    assert b_from == date(2024, 1, 1)
    assert b_to == date(2024, 12, 31)
    assert b_bars == bars


def test_daily_cache_separates_venue_batches() -> None:
    cache = PastDailyCandlesCache()
    krx_bars = [_bar(1000)]
    un_bars = [_bar(2000)]

    cache.append_batch("KRX", "005930", date(2024, 1, 1), date(2024, 1, 31), krx_bars)
    cache.append_batch("UN", "005930", date(2024, 1, 1), date(2024, 1, 31), un_bars)

    assert cache.list_batches("KRX", "005930")[0][2] == krx_bars
    assert cache.list_batches("UN", "005930")[0][2] == un_bars


def test_daily_today_cache_separates_venue() -> None:
    cache = PastDailyCandlesCache()
    krx_bar = _bar(1000)
    un_bar = _bar(2000)

    cache.store_today("KRX", "005930", krx_bar)
    cache.store_today("UN", "005930", un_bar)

    assert cache.get_today("KRX", "005930") == ("hit", krx_bar)
    assert cache.get_today("UN", "005930") == ("hit", un_bar)


def test_multiple_batches_kept_in_insertion_order() -> None:
    cache = PastDailyCandlesCache()
    cache.append_batch("005930", date(2024, 1, 1), date(2024, 12, 31), [_bar(1)])
    cache.append_batch("005930", date(2023, 1, 1), date(2023, 12, 31), [_bar(2)])
    out = cache.list_batches("005930")
    assert len(out) == 2
    assert out[0][0] == date(2024, 1, 1)
    assert out[1][0] == date(2023, 1, 1)


def test_today_hit_returns_dict() -> None:
    cache = PastDailyCandlesCache()
    bar = _bar(1000)
    cache.store_today("005930", bar)
    state, value = cache.get_today("005930")
    assert state == "hit"
    assert value == bar


def test_today_miss_returns_miss_state() -> None:
    cache = PastDailyCandlesCache()
    state, value = cache.get_today("005930")
    assert state == "miss"
    assert value is None


def test_today_negative_cache() -> None:
    cache = PastDailyCandlesCache()
    cache.store_today("005930", None)
    state, value = cache.get_today("005930")
    assert state == "negative"
    assert value is None


def test_today_ttl_expiry_returns_miss() -> None:
    cache = PastDailyCandlesCache(today_ttl_seconds=10.0)
    cache.store_today("005930", _bar(1000))
    with patch("hoga.live.past_daily_candles_cache.time.monotonic",
               return_value=time.monotonic() + 11.0):
        state, value = cache.get_today("005930")
    assert state == "miss"
    assert value is None


def test_negative_cache_ttl_expiry_returns_miss() -> None:
    cache = PastDailyCandlesCache(today_ttl_seconds=10.0)
    cache.store_today("005930", None)
    with patch("hoga.live.past_daily_candles_cache.time.monotonic",
               return_value=time.monotonic() + 11.0):
        state, _ = cache.get_today("005930")
    assert state == "miss"
