"""Unit tests for the shared daily walk-back orchestrator.

`batched_daily_walkback` concentrates the gap/cache/today-tristate/dedupe
assembly that /past-daily-candles and /past-investor-net both used to copy-paste
inline. These tests exercise that orchestration ONCE through a fake cache + fake
`fetch_batch` — no FastAPI route-driving, no KIS mock. The two routes keep only
thin adapter smoke tests in test_api.py.
"""
from __future__ import annotations

import asyncio
from datetime import date, datetime

import httpx

from hoga.live.api import batched_daily_walkback, _KST
from hoga.live.kis_client import KisApiError, KisRateLimitError, KisTransportError


def _t_ms(d: date, hour: int = 9) -> int:
    return int(datetime(d.year, d.month, d.day, hour, 0, 0, tzinfo=_KST).timestamp() * 1000)


class _FakeCache:
    def __init__(self, batches=None, today=("miss", None)):
        self._batches = list(batches or [])  # list[(date, date, list[dict])]
        self._today = today
        self.appended: list[tuple[date, date, list[dict]]] = []
        self.stored_today: list[dict | None] = []

    def list_batches(self, code: str):
        return list(self._batches)

    def append_batch(self, code: str, frm: date, to: date, rows: list[dict]) -> None:
        self.appended.append((frm, to, rows))

    def get_today(self, code: str):
        return self._today

    def store_today(self, code: str, bar: dict | None) -> None:
        self.stored_today.append(bar)


def _run(coro):
    return asyncio.run(coro)


def test_gap_calls_fetch_records_fresh_and_appends() -> None:
    cache = _FakeCache()
    calls: list[tuple[str, str, str]] = []

    async def fetch_batch(code, from_s, to_s):
        calls.append((code, from_s, to_s))
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "v": 1}], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert len(calls) == 1  # one gap fetched
    assert out["candles"] and out["candles"][0]["v"] == 1
    assert out["fresh_batches"] == ["20240101__20240105"]
    assert out["cached_batches"] == []
    assert cache.appended  # persisted to cache
    assert out["code"] == "005930" and out["from"] == "20240101" and out["to"] == "20240105"


def test_cache_hit_skips_fetch() -> None:
    cache = _FakeCache(batches=[(date(2024, 1, 1), date(2024, 1, 5),
                                 [{"t_ms": _t_ms(date(2024, 1, 2)), "v": 7}])])
    called = False

    async def fetch_batch(code, from_s, to_s):
        nonlocal called
        called = True
        return [], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert called is False  # fully covered by cache → no KIS round-trip
    assert out["cached_batches"] == ["20240101__20240105"]
    assert out["candles"][0]["v"] == 7


def test_rate_limit_breaks_loop_and_warns() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisRateLimitError("EGW00201 too many requests")

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert out["candles"] == []
    assert any(w["reason"] == "kis_rate_limit" for w in out["data_warnings"])
    assert out["fresh_batches"] == []


def test_api_error_continues_with_warning() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisApiError(msg_cd="ERR99", msg1="boom")

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert any(w["reason"] == "kis_api_error" for w in out["data_warnings"])


def test_transport_error_continues_with_distinct_warning() -> None:
    """A KisTransportError (TCP disconnect mid-backfill) must NOT propagate out
    of the walk-back as a 500 — it degrades like an api error (skip the batch,
    keep going) but records a DISTINCT ``kis_transport`` reason so operators
    can tell a network blip from a KIS rejection (different remediation).
    Regression: 2026-06-11 foreground daily-candle backfill 500, where
    ``httpx.RemoteProtocolError`` escaped the client uncaught."""
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        raise KisTransportError(httpx.RemoteProtocolError("server disconnected"))

    # Must return normally (no raise) — that is what closes the 500.
    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert out["candles"] == []
    assert any(w["reason"] == "kis_transport" for w in out["data_warnings"])
    # Not misreported as a generic api error.
    assert not any(w["reason"] == "kis_api_error" for w in out["data_warnings"])


def test_output_key_is_parameterized() -> None:
    cache = _FakeCache()

    async def fetch_batch(code, from_s, to_s):
        return [{"t_ms": _t_ms(date(2024, 1, 3)), "foreign_net": 5}], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="points",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert "points" in out and "candles" not in out
    assert out["points"][0]["foreign_net"] == 5


def test_today_miss_fetches_and_stores() -> None:
    cache = _FakeCache(today=("miss", None))
    today = date(2024, 1, 5)

    async def fetch_batch(code, from_s, to_s):
        # today_s == today range; return today's row
        return [{"t_ms": _t_ms(today), "v": 9}], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=today, too=today, today_d=today,
    ))

    assert cache.stored_today == [{"t_ms": _t_ms(today), "v": 9}]
    assert out["fresh_batches"] == ["20240105__20240105"]
    assert out["candles"][0]["v"] == 9


def test_dedupe_by_t_ms_keeps_last() -> None:
    ts = _t_ms(date(2024, 1, 3))
    cache = _FakeCache(batches=[(date(2024, 1, 1), date(2024, 1, 5),
                                 [{"t_ms": ts, "v": 1}, {"t_ms": ts, "v": 2}])])

    async def fetch_batch(code, from_s, to_s):
        return [], []

    out = _run(batched_daily_walkback(
        cache=cache, fetch_batch=fetch_batch, output_key="candles",
        code="005930", frm=date(2024, 1, 1), too=date(2024, 1, 5), today_d=date(2024, 2, 1),
    ))

    assert len(out["candles"]) == 1  # deduped by t_ms
    assert out["candles"][0]["v"] == 2  # last wins
