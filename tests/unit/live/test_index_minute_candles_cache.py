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
        ("kis", "KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    second = await collect_index_minute_candles_with_cache(
        cache,
        ("kis", "KOSPI", "1m", 60),
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
        ("kis", "KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    broader = await collect_index_minute_candles_with_cache(
        cache,
        ("kis", "KOSPI", "1m", 60),
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
        ("kis", "KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )
    second = await collect_index_minute_candles_with_cache(
        cache,
        ("kis", "KOSPI", "1m", 60),
        "20260622",
        "20260622",
        fetch_batch,
    )

    assert calls == [("20260622", "20260622")]
    assert first.violations == [warning]
    assert second.violations == [warning]


@pytest.mark.asyncio
async def test_today_window_refetches_after_ttl() -> None:
    """오늘을 포함한 창은 TTL 후 재fetch — 장중 새 봉이 붙는 지점."""
    clock = {"t": 0.0}
    cache = IndexMinuteCandlesCache(today_ttl_seconds=60.0, monotonic=lambda: clock["t"])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(len(calls), float(len(calls)))])

    async def collect() -> IndexCandleFetchResult:
        return await collect_index_minute_candles_with_cache(
            cache,
            ("kis", "KOSPI", "1m", 60),
            "20260622",
            "20260629",
            fetch_batch,
            today_yyyymmdd="20260629",
        )

    first = await collect()
    clock["t"] = 59.0
    cached = await collect()
    clock["t"] = 60.0
    refetched = await collect()

    assert [c.close for c in first.candles] == [1.0]
    assert [c.close for c in cached.candles] == [1.0], "TTL 이내는 캐시"
    assert [c.close for c in refetched.candles] == [2.0], "TTL 경과 후 재fetch"
    assert len(calls) == 2


@pytest.mark.asyncio
async def test_past_only_window_never_expires() -> None:
    """to < today 인 과거 전용 창은 불변 — 시간이 흘러도 재fetch 하지 않는다."""
    clock = {"t": 0.0}
    cache = IndexMinuteCandlesCache(today_ttl_seconds=60.0, monotonic=lambda: clock["t"])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(1, 1.0)])

    for elapsed in (0.0, 3600.0):
        clock["t"] = elapsed
        await collect_index_minute_candles_with_cache(
            cache,
            ("kis", "KOSPI", "1m", 60),
            "20260622",
            "20260626",
            fetch_batch,
            today_yyyymmdd="20260629",
        )

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_missing_today_argument_keeps_legacy_no_expiry() -> None:
    """today 를 안 주는 호출자(우회 경로 등)는 종전대로 만료 없음."""
    clock = {"t": 0.0}
    cache = IndexMinuteCandlesCache(today_ttl_seconds=60.0, monotonic=lambda: clock["t"])
    calls: list[tuple[str, str]] = []

    async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
        calls.append((from_s, to_s))
        return IndexCandleFetchResult(candles=[point(1, 1.0)])

    for elapsed in (0.0, 3600.0):
        clock["t"] = elapsed
        await collect_index_minute_candles_with_cache(
            cache, ("kis", "KOSPI", "1m", 60), "20260622", "20260629", fetch_batch,
        )

    assert len(calls) == 1


@pytest.mark.asyncio
async def test_source_is_part_of_the_key() -> None:
    """소스가 다르면 캐시를 공유하지 않는다 (ADR-0129 D4).

    두 소스의 depth 가 크게 다르므로(KIS 102행 vs 키움 900행/페이지), 키를 공유하면
    소스 전환 직후 짧은 쪽 응답이 긴 쪽 자리를 차지한다.
    """
    cache = IndexMinuteCandlesCache()
    calls: list[str] = []

    def fetch_for(source: str):
        async def fetch_batch(from_s: str, to_s: str) -> IndexCandleFetchResult:
            calls.append(source)
            return IndexCandleFetchResult(
                candles=[point(1, 1.0 if source == "kis" else 2.0)]
            )
        return fetch_batch

    from_s, to_s = "20260622", "20260622"
    kis = await collect_index_minute_candles_with_cache(
        cache, ("kis", "KOSPI", "1m", 60), from_s, to_s, fetch_for("kis"),
    )
    kiwoom = await collect_index_minute_candles_with_cache(
        cache, ("kiwoom", "KOSPI", "1m", 60), from_s, to_s, fetch_for("kiwoom"),
    )

    assert calls == ["kis", "kiwoom"], "각 소스가 자기 fetch 를 탄다"
    assert [c.close for c in kis.candles] == [1.0]
    assert [c.close for c in kiwoom.candles] == [2.0], "키움이 KIS 캐시를 재사용하지 않는다"


def test_exact_cache_is_lru_bounded() -> None:
    """WS4: exact-match 분봉 캐시는 무한 축적하지 않는다 — LRU 상한."""
    cache = IndexMinuteCandlesCache(max_exact_entries=2)
    key = ("kis", "KOSPI", "1m", 60)
    r = IndexCandleFetchResult(candles=[point(1, 1.0)])

    cache.store_exact(key, "20260620", "20260620", r)
    cache.store_exact(key, "20260621", "20260621", r)
    assert cache.get_exact(key, "20260620", "20260620") is not None  # touch
    cache.store_exact(key, "20260622", "20260622", r)

    assert cache.get_exact(key, "20260621", "20260621") is None  # LRU 축출
    assert cache.get_exact(key, "20260620", "20260620") is not None
    assert cache.get_exact(key, "20260622", "20260622") is not None
