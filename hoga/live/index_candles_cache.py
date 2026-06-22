from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, date, timedelta
from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import DailyInvariantViolation, IndexCandleFetchResult, KIS_KST
from hoga.live.kis_models import IndexCandlePoint

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


class IndexCandlesCache:
    def __init__(self) -> None:
        self._per_key: dict[
            IndexCandleCacheKey,
            list[IndexCandleCacheBatch],
        ] = {}

    def append_batch(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
        candles: list[IndexCandlePoint],
        *,
        violations: list[DailyInvariantViolation] | None = None,
    ) -> None:
        self._per_key.setdefault(key, []).append((frm, to, list(candles), list(violations or [])))

    def list_batches(
        self,
        key: IndexCandleCacheKey,
    ) -> list[IndexCandleCacheBatch]:
        return list(self._per_key.get(key, []))

    def covered(
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
    return datetime.fromtimestamp(point.t_ms / 1000, KIS_KST).date()


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
        if len(date_s) != 8:
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
) -> IndexCandleFetchResult:
    frm = _parse_yyyymmdd(from_s)
    to = _parse_yyyymmdd(to_s)
    hit = cache.covered(key, frm, to)
    if hit is not None:
        return IndexCandleFetchResult(candles=hit.candles, violations=hit.violations or [])

    existing = cache.list_batches(key)
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

    final_hit = cache.covered(key, frm, to)
    candles = final_hit.candles if final_hit is not None else []
    final_violations = final_hit.violations if final_hit is not None else violations
    return IndexCandleFetchResult(candles=candles, violations=final_violations or [])
