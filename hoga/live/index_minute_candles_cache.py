from __future__ import annotations

from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import IndexCandleFetchResult

IndexMinuteCacheKey: TypeAlias = tuple[str, str, int]


class IndexMinuteCandlesCache:
    def __init__(self) -> None:
        self._exact: dict[tuple[IndexMinuteCacheKey, str, str], IndexCandleFetchResult] = {}

    def get_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
    ) -> IndexCandleFetchResult | None:
        return self._exact.get((key, from_s, to_s))

    def store_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
        result: IndexCandleFetchResult,
    ) -> None:
        self._exact[(key, from_s, to_s)] = IndexCandleFetchResult(
            candles=list(result.candles),
            violations=list(result.violations),
        )


async def collect_index_minute_candles_with_cache(
    cache: IndexMinuteCandlesCache,
    key: IndexMinuteCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
) -> IndexCandleFetchResult:
    hit = cache.get_exact(key, from_s, to_s)
    if hit is not None:
        return IndexCandleFetchResult(
            candles=list(hit.candles),
            violations=list(hit.violations),
        )
    result = await fetch_batch(from_s, to_s)
    cache.store_exact(key, from_s, to_s, result)
    return result
