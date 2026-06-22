from __future__ import annotations

from datetime import date

import pytest

from hoga.live.index_candles_cache import (
    IndexCandleCacheHit,
    IndexCandlesCache,
    collect_index_candles_with_cache,
)
from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint


def point(day: str, close: float = 1.0) -> IndexCandlePoint:
    return IndexCandlePoint(
        t_ms=int(day),
        open=close,
        high=close,
        low=close,
        close=close,
        volume=100,
    )


def test_cache_returns_exact_covered_range_without_fetching() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [point("20260102")],
    )

    hit = cache.covered(("KOSDAQ", "D"), date(2026, 1, 10), date(2026, 1, 20))

    assert hit == IndexCandleCacheHit(candles=[point("20260102")])


@pytest.mark.asyncio
async def test_collector_fetches_only_missing_left_gap_and_merges_cached_rows() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [point("20260115", 15)],
    )
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point("20251215", 12)])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "D"),
        "20251201",
        "20260131",
        fetch_batch,
    )

    assert calls == [("20251201", "20251231")]
    assert [c.close for c in result.candles] == [12, 15]
    assert result.violations == []


@pytest.mark.asyncio
async def test_cache_key_separates_timeframes() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [point("20260115", 15)],
    )
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point("20260120", 20)])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "W"),
        "20260101",
        "20260131",
        fetch_batch,
    )

    assert calls == [("20260101", "20260131")]
    assert [c.close for c in result.candles] == [20]
