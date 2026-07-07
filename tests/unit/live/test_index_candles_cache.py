from __future__ import annotations

from datetime import datetime, date

import pytest

from hoga.live.index_candles_cache import (
    IndexCandleCacheHit,
    IndexCandlesCache,
    collect_index_candles_with_cache,
)
from hoga.live.kis_client import DailyInvariantViolation, IndexCandleFetchResult, KIS_KST
from hoga.live.kis_models import IndexCandlePoint


def point(day: str, close: float = 1.0) -> IndexCandlePoint:
    dt = datetime(
        int(day[:4]),
        int(day[4:6]),
        int(day[6:8]),
        15,
        30,
        tzinfo=KIS_KST,
    )
    return IndexCandlePoint(
        t_ms=int(dt.timestamp() * 1000),
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

    assert hit == IndexCandleCacheHit(candles=[])


def test_cache_filters_covered_batch_to_requested_range_and_dedupes() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [
            point("20260102", 2),
            point("20260115", 15),
            point("20260115", 99),
            point("20260125", 25),
        ],
    )

    hit = cache.covered(("KOSDAQ", "D"), date(2026, 1, 10), date(2026, 1, 20))

    assert hit == IndexCandleCacheHit(candles=[point("20260115", 99)])


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
async def test_collector_fetches_internal_gaps_between_cached_islands() -> None:
    cache = IndexCandlesCache()
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [point("20260115", 15)],
    )
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 3, 1),
        date(2026, 3, 31),
        [point("20260315", 31)],
    )
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point("20260215", 20)])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "D"),
        "20260101",
        "20260331",
        fetch_batch,
    )

    assert calls == [("20260201", "20260228")]
    assert [c.close for c in result.candles] == [15, 20, 31]
    assert result.violations == []


@pytest.mark.asyncio
async def test_cache_hit_preserves_violations_for_requested_range() -> None:
    cache = IndexCandlesCache()
    warning = DailyInvariantViolation(
        date_yyyymmdd="20260115",
        reason="malformed_row",
        detail="bad row",
    )
    cache.append_batch(
        ("KOSDAQ", "D"),
        date(2026, 1, 1),
        date(2026, 1, 31),
        [point("20260115", 15)],
        violations=[warning],
    )
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[])

    result = await collect_index_candles_with_cache(
        cache,
        ("KOSDAQ", "D"),
        "20260110",
        "20260120",
        fetch_batch,
    )

    assert calls == []
    assert [c.close for c in result.candles] == [15]
    assert result.violations == [warning]


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


def test_per_key_batches_are_capped_oldest_dropped() -> None:
    """WS4: per-key 배치 리스트는 캡을 넘으면 oldest부터 드랍 — 커버리지 구멍은
    covered()가 None을 돌려 재fetch로 회복되므로 정확성은 불변."""
    cache = IndexCandlesCache(max_batches_per_key=2)
    key = ("KOSPI", "D")
    cache.append_batch(key, date(2026, 1, 1), date(2026, 1, 31), [point("20260102")])
    cache.append_batch(key, date(2026, 2, 1), date(2026, 2, 28), [point("20260203")])
    cache.append_batch(key, date(2026, 3, 1), date(2026, 3, 31), [point("20260304")])

    assert len(cache.list_batches(key)) == 2
    # oldest(1월) 드랍 → 1월 조회는 미스(재fetch 신호)
    assert cache.covered(key, date(2026, 1, 10), date(2026, 1, 20)) is None
    # 최근 배치들은 유지
    assert cache.covered(key, date(2026, 3, 10), date(2026, 3, 20)) is not None
