from __future__ import annotations

import pytest

from hoga.live.index_minute_candles_cache import (
    IndexMinuteCandlesCache,
    collect_index_minute_candles_with_cache,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(t_ms: int, close: float) -> IndexCandlePoint:
    return IndexCandlePoint(
        t_ms=t_ms,
        open=close,
        high=close,
        low=close,
        close=close,
        volume=1,
    )


@pytest.mark.asyncio
async def test_repeated_exact_minute_request_uses_cache() -> None:
    cache = IndexMinuteCandlesCache()
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(1, 1.0)])

    first = await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    second = await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )

    assert [c.close for c in first.candles] == [1.0]
    assert [c.close for c in second.candles] == [1.0]
    assert calls == [("20260622", "20260622")]


@pytest.mark.asyncio
async def test_broader_range_does_not_claim_cache_hit_when_cached_rows_do_not_cover_it() -> None:
    cache = IndexMinuteCandlesCache()
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        close = float(len(calls))
        return IndexCandleFetchResult(candles=[point(len(calls), close)])

    await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    broader = await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260601",
        "20260622",
        fetch_batch,
    )

    assert calls == [("20260622", "20260622"), ("20260601", "20260622")]
    assert [c.close for c in broader.candles] == [2.0]


@pytest.mark.asyncio
async def test_exact_cache_preserves_row_level_violations_without_refetching() -> None:
    cache = IndexMinuteCandlesCache()
    calls: list[tuple[str, str]] = []
    warning = object()

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(1, 1.0)], violations=[warning])

    first = await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    second = await collect_index_minute_candles_with_cache(
        cache,
        ("KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )

    assert calls == [("20260622", "20260622")]
    assert first.violations == [warning]
    assert second.violations == [warning]


def test_exact_cache_is_lru_bounded() -> None:
    """WS4: exact-match 분봉 캐시는 무한 축적하지 않는다 — LRU 상한."""
    cache = IndexMinuteCandlesCache(max_exact_entries=2)
    key = ("KOSPI", "1m", 60)
    r = IndexCandleFetchResult(candles=[point(1, 1.0)])

    cache.store_exact(key, "20260620", "20260620", r)
    cache.store_exact(key, "20260621", "20260621", r)
    assert cache.get_exact(key, "20260620", "20260620") is not None  # touch
    cache.store_exact(key, "20260622", "20260622", r)

    assert cache.get_exact(key, "20260621", "20260621") is None  # LRU 축출
    assert cache.get_exact(key, "20260620", "20260620") is not None
    assert cache.get_exact(key, "20260622", "20260622") is not None
