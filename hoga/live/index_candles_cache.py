from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import TypeAlias

from hoga.live.candle_fetch_result import DailyInvariantViolation, IndexCandleFetchResult
from hoga.live.candle_models import IndexCandlePoint
from hoga.live.single_flight import SingleFlight
from hoga.util.cache_stats import CacheStats
from hoga.util.timeenc import KST

IndexCandleCacheKey: TypeAlias = tuple[str, str]
IndexCandleCacheBatch: TypeAlias = tuple[
    date,
    date,
    list[IndexCandlePoint],
    list[DailyInvariantViolation],
]


@dataclass(frozen=True)
class IndexCandleCacheHit:
    candles: list[IndexCandlePoint]
    violations: list[DailyInvariantViolation] = field(default_factory=list)


# WS4: per-key 배치 리스트 무한 append 방지. 키(대표지수×프레임)는 유계지만
# 배치는 러닝 일수만큼 쌓인다. 캡 초과 시 oldest 드랍 — 커버리지 구멍은
# covered()가 None을 돌려 해당 구간만 재fetch되므로 정확성 불변.
DEFAULT_MAX_BATCHES_PER_KEY = 128
TODAY_TTL_SECONDS = 60.0


def mutable_period_start(today: date, timeframe: str) -> date:
    if timeframe == "W":
        return today - timedelta(days=today.weekday())
    if timeframe == "M":
        return today.replace(day=1)
    return today


class IndexCandlesCache:
    def __init__(
        self, *, max_batches_per_key: int = DEFAULT_MAX_BATCHES_PER_KEY,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        self._max_batches_per_key = max(1, int(max_batches_per_key))
        self._per_key: dict[
            IndexCandleCacheKey,
            list[IndexCandleCacheBatch],
        ] = {}
        self._stats = CacheStats()
        # Current D/W/M periods never enter the immutable history tier.
        self._mutable: dict[IndexCandleCacheKey, tuple[IndexCandleCacheBatch, float]] = {}
        self._today_ttl = today_ttl_seconds
        self._clock = monotonic
        self._inflight = SingleFlight()

    def stats_snapshot(self) -> dict[str, int | float | None]:
        total_batches = sum(len(b) for b in self._per_key.values()) + len(self._mutable)
        return self._stats.snapshot(size=total_batches)

    def append_batch(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
        candles: list[IndexCandlePoint],
        *,
        violations: list[DailyInvariantViolation] | None = None,
    ) -> None:
        batches = self._per_key.setdefault(key, [])
        batches.append((frm, to, list(candles), list(violations or [])))
        self._stats.record_store()
        if len(batches) > self._max_batches_per_key:
            overflow = len(batches) - self._max_batches_per_key
            del batches[:overflow]
            self._stats.record_eviction(overflow)

    def list_batches(
        self,
        key: IndexCandleCacheKey,
    ) -> list[IndexCandleCacheBatch]:
        batches = list(self._per_key.get(key, []))
        if key in self._mutable:
            # Cache-only/bypass reads may still show the last successful window.
            batches.append(self._mutable[key][0])
        return batches

    def covered(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
        *,
        count: bool = True,
    ) -> IndexCandleCacheHit | None:
        # `count` gates stats: collect_index_candles_with_cache calls covered()
        # twice — once as the real lookup, once to re-assemble after fetching the
        # gaps. Only the first (count=True) is a cache lookup (advisor #2 pattern).
        hit = self._covered(key, frm, to)
        if count:
            if hit is not None:
                self._stats.record_hit()
            else:
                self._stats.record_miss()
        return hit

    def _covered(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
    ) -> IndexCandleCacheHit | None:
        batches = self._per_key.get(key, [])
        if not batches:
            return None
        covered_start: date | None = None
        covered_end: date | None = None
        candles: list[IndexCandlePoint] = []
        violations: list[DailyInvariantViolation] = []
        for batch_from, batch_to, batch_candles, batch_violations in sorted(batches, key=lambda b: b[0]):
            if batch_to < frm or batch_from > to:
                continue
            if covered_start is None:
                covered_start = batch_from
                covered_end = batch_to
            elif covered_end is not None and batch_from <= covered_end + timedelta(days=1):
                covered_end = max(covered_end, batch_to)
            else:
                return None
            candles.extend(batch_candles)
            violations.extend(batch_violations)
        if (
            covered_start is not None
            and covered_end is not None
            and covered_start <= frm
            and covered_end >= to
        ):
            return IndexCandleCacheHit(
                candles=_filter_dedupe_points(candles, frm, to),
                violations=_filter_violations(violations, frm, to),
            )
        return None


def _parse_yyyymmdd(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def _fmt(d: date) -> str:
    return d.strftime("%Y%m%d")


def _point_date(point: IndexCandlePoint) -> date:
    return datetime.fromtimestamp(point.t_ms / 1000, KST).date()


def _filter_dedupe_points(
    candles: list[IndexCandlePoint],
    frm: date,
    to: date,
) -> list[IndexCandlePoint]:
    by_ts: dict[int, IndexCandlePoint] = {}
    for candle in candles:
        candle_day = _point_date(candle)
        if frm <= candle_day <= to:
            by_ts[candle.t_ms] = candle
    return [by_ts[ts] for ts in sorted(by_ts)]


def _filter_violations(
    violations: list[DailyInvariantViolation],
    frm: date,
    to: date,
) -> list[DailyInvariantViolation]:
    kept: list[DailyInvariantViolation] = []
    for violation in violations:
        date_s = violation.date_yyyymmdd
        if len(date_s) != 8:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            continue
        violation_day = _parse_yyyymmdd(date_s)
        if frm <= violation_day <= to:
            kept.append(violation)
    return kept


def _missing_ranges(
    batches: list[IndexCandleCacheBatch],
    frm: date,
    to: date,
) -> list[tuple[date, date]]:
    intervals = [
        (max(batch_from, frm), min(batch_to, to))
        for batch_from, batch_to, _, _ in batches
        if batch_to >= frm and batch_from <= to
    ]
    if not intervals:
        return [(frm, to)]

    merged: list[tuple[date, date]] = []
    for start, end in sorted(intervals):
        if not merged or start > merged[-1][1] + timedelta(days=1):
            merged.append((start, end))
        else:
            merged[-1] = (merged[-1][0], max(merged[-1][1], end))

    ranges: list[tuple[date, date]] = []
    cursor = frm
    for start, end in merged:
        if cursor < start:
            ranges.append((cursor, start - timedelta(days=1)))
        cursor = max(cursor, end + timedelta(days=1))
    if cursor <= to:
        ranges.append((cursor, to))
    return ranges


async def collect_index_candles_with_cache(
    cache: IndexCandlesCache,
    key: IndexCandleCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
    *,
    today: date | None = None,
) -> IndexCandleFetchResult:
    today = today or datetime.now(KST).date()
    frm, to = _parse_yyyymmdd(from_s), _parse_yyyymmdd(to_s)
    boundary = mutable_period_start(today, key[1])
    async with cache._inflight.acquire(key):
        if to < boundary:
            return await _collect_past_candles(cache, key, from_s, to_s, fetch_batch)
        past = IndexCandleFetchResult(candles=[], violations=[])
        if frm < boundary:
            past = await _collect_past_candles(
                cache, key, from_s, _fmt(boundary - date.resolution), fetch_batch,
            )
        tail_from = max(frm, boundary)
        entry = cache._mutable.get(key)
        if (
            entry is not None and cache._clock() - entry[1] < cache._today_ttl
            and entry[0][0] >= boundary and entry[0][0] <= tail_from and entry[0][1] >= to
        ):
            cache._stats.record_hit()
            batch = entry[0]
            tail = IndexCandleFetchResult(
                candles=_filter_dedupe_points(batch[2], tail_from, to),
                violations=_filter_violations(batch[3], tail_from, to),
            )
        else:
            cache._stats.record_miss()
            tail = await fetch_batch(_fmt(tail_from), to_s)
            if not tail.violations:
                cache._mutable[key] = (
                    (tail_from, to, list(tail.candles), []), cache._clock(),
                )
                cache._stats.record_store()
        return IndexCandleFetchResult(
            candles=_filter_dedupe_points([*past.candles, *tail.candles], frm, to),
            violations=[*past.violations, *tail.violations],
        )


async def _collect_past_candles(
    cache: IndexCandlesCache,
    key: IndexCandleCacheKey,
    from_s: str,
    to_s: str,
    fetch_batch: Callable[[str, str], Awaitable[IndexCandleFetchResult]],
) -> IndexCandleFetchResult:
    frm = _parse_yyyymmdd(from_s)
    to = _parse_yyyymmdd(to_s)
    hit = cache.covered(key, frm, to)
    if hit is not None:
        return IndexCandleFetchResult(candles=hit.candles, violations=hit.violations or [])

    # A prior day's mutable row is not a verified closing value. Re-fetch it
    # after rollover instead of treating the cache-only fallback as history.
    existing = list(cache._per_key.get(key, []))
    fetch_ranges = _missing_ranges(existing, frm, to)

    violations = []
    for fetch_from, fetch_to in fetch_ranges:
        if fetch_from > fetch_to:
            continue
        result = await fetch_batch(_fmt(fetch_from), _fmt(fetch_to))
        violations.extend(result.violations)
        cache.append_batch(
            key,
            fetch_from,
            fetch_to,
            result.candles,
            violations=result.violations,
        )

    final_hit = cache.covered(key, frm, to, count=False)
    candles = final_hit.candles if final_hit is not None else []
    final_violations = final_hit.violations if final_hit is not None else violations
    return IndexCandleFetchResult(candles=candles, violations=final_violations or [])
