from __future__ import annotations

from collections import OrderedDict
from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import IndexCandleFetchResult

IndexMinuteCacheKey: TypeAlias = tuple[str, str, int]

# WS4: exact-match 분봉 결과(수천 캔들)가 (from,to) 조합마다 영구 축적되던
# 무제한 dict에 LRU 상한. 축출 비용은 KIS 재fetch 1회일 뿐, 정확성 불변.
DEFAULT_MAX_EXACT_ENTRIES = 64


class IndexMinuteCandlesCache:
    def __init__(self, *, max_exact_entries: int = DEFAULT_MAX_EXACT_ENTRIES) -> None:
        self._max_exact_entries = max(0, int(max_exact_entries))
        self._exact: OrderedDict[
            tuple[IndexMinuteCacheKey, str, str], IndexCandleFetchResult
        ] = OrderedDict()

    def get_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
    ) -> IndexCandleFetchResult | None:
        full_key = (key, from_s, to_s)
        hit = self._exact.get(full_key)
        if hit is not None:
            self._exact.move_to_end(full_key)
        return hit

    def store_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
        result: IndexCandleFetchResult,
    ) -> None:
        full_key = (key, from_s, to_s)
        self._exact[full_key] = IndexCandleFetchResult(
            candles=list(result.candles),
            violations=list(result.violations),
        )
        self._exact.move_to_end(full_key)
        while len(self._exact) > self._max_exact_entries:
            self._exact.popitem(last=False)


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
