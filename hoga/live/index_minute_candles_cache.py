from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import TypeAlias

from hoga.live.candle_fetch_result import IndexCandleFetchResult
from hoga.util.cache_stats import CacheStats

# (source, index_id, timeframe, bucket_seconds). `source` 는 캔들을 준 브로커
# ("kis"/"kiwoom") — 소스를 바꿨을 때 이전 소스의 캔들이 stale 로 살아남지 않도록
# 키에 넣는다(ADR-0129 D4). 두 소스의 depth 가 크게 다르므로, 키를 공유하면 전환
# 직후 짧은 쪽 응답이 긴 쪽을 덮거나 그 반대가 된다.
IndexMinuteCacheKey: TypeAlias = tuple[str, str, str, int]

# WS4: exact-match 분봉 결과(수천 캔들)가 (from,to) 조합마다 영구 축적되던
# 무제한 dict에 LRU 상한. 축출 비용은 KIS 재fetch 1회일 뿐, 정확성 불변.
DEFAULT_MAX_EXACT_ENTRIES = 64

# 오늘을 포함한 창의 만료 시각(초). 종목 분봉(past_candles_cache.TODAY_TTL_SECONDS)과
# 같은 값 — 지수 분봉만 TTL 이 없어 장중에 첫 응답이 영구 재사용됐고, 프론트가
# 60초마다 다시 물어도 새 봉이 붙지 않았다. 과거 전용 창(to < today)은 불변이므로
# 만료시키지 않는다.
TODAY_TTL_SECONDS = 60.0


class IndexMinuteCandlesCache:
    def __init__(
        self,
        *,
        max_exact_entries: int = DEFAULT_MAX_EXACT_ENTRIES,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_exact_entries = max(0, int(max_exact_entries))
        self._today_ttl_seconds = float(today_ttl_seconds)
        self._monotonic = monotonic
        self._exact: OrderedDict[
            tuple[IndexMinuteCacheKey, str, str], tuple[IndexCandleFetchResult, float]
        ] = OrderedDict()
        self._stats = CacheStats()

    @property
    def today_ttl_seconds(self) -> float:
        return self._today_ttl_seconds

    def stats_snapshot(self) -> dict[str, int | float | None]:
        return self._stats.snapshot(size=len(self._exact))

    def get_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
        *,
        ttl_seconds: float | None = None,
    ) -> IndexCandleFetchResult | None:
        """저장된 결과, 없거나 `ttl_seconds` 초과면 None.

        `ttl_seconds=None`(기본)은 만료 없음 — 과거 전용 창의 시맨틱이다.
        """
        full_key = (key, from_s, to_s)
        entry = self._exact.get(full_key)
        if (
            entry is not None
            and ttl_seconds is not None
            and self._monotonic() - entry[1] >= ttl_seconds
        ):
            self._exact.pop(full_key, None)
            entry = None
        if entry is not None:
            self._exact.move_to_end(full_key)
            self._stats.record_hit()
            return entry[0]
        self._stats.record_miss()
        return None

    def store_exact(
        self,
        key: IndexMinuteCacheKey,
        from_s: str,
        to_s: str,
        result: IndexCandleFetchResult,
    ) -> None:
        full_key = (key, from_s, to_s)
        self._exact[full_key] = (
            IndexCandleFetchResult(
                candles=list(result.candles),
                violations=list(result.violations),
            ),
            self._monotonic(),
        )
        self._exact.move_to_end(full_key)
        self._stats.record_store()
        while len(self._exact) > self._max_exact_entries:
            self._exact.popitem(last=False)
            self._stats.record_eviction()


async def collect_index_minute_candles_with_cache(
    cache: IndexMinuteCandlesCache,
    key: IndexMinuteCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
    *,
    today_yyyymmdd: str | None = None,
) -> IndexCandleFetchResult:
    """캐시된 (from,to) 결과, 없으면 fetch 후 저장.

    `today_yyyymmdd` 를 주면 오늘을 포함한 창(to >= today)에만 TTL 이 걸린다 —
    장중 새 봉이 붙게 하는 지점. 생략하면 종전대로 만료 없음(과거 전용 호출자).
    """
    includes_today = today_yyyymmdd is not None and to_s >= today_yyyymmdd
    hit = cache.get_exact(
        key,
        from_s,
        to_s,
        ttl_seconds=cache.today_ttl_seconds if includes_today else None,
    )
    if hit is not None:
        return IndexCandleFetchResult(
            candles=list(hit.candles),
            violations=list(hit.violations),
        )
    result = await fetch_batch(from_s, to_s)
    cache.store_exact(key, from_s, to_s, result)
    return result
