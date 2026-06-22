from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Awaitable, Callable, TypeAlias

from hoga.live.kis_client import IndexCandleFetchResult
from hoga.live.kis_models import IndexCandlePoint

IndexCandleCacheKey: TypeAlias = tuple[str, str]


@dataclass(frozen=True)
class IndexCandleCacheHit:
    candles: list[IndexCandlePoint]


class IndexCandlesCache:
    def __init__(self) -> None:
        self._per_key: dict[
            IndexCandleCacheKey,
            list[tuple[date, date, list[IndexCandlePoint]]],
        ] = {}

    def append_batch(
        self,
        key: IndexCandleCacheKey,
        frm: date,
        to: date,
        candles: list[IndexCandlePoint],
    ) -> None:
        self._per_key.setdefault(key, []).append((frm, to, list(candles)))

    def list_batches(
        self,
        key: IndexCandleCacheKey,
    ) -> list[tuple[date, date, list[IndexCandlePoint]]]:
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
        for batch_from, batch_to, batch_candles in sorted(batches, key=lambda b: b[0]):
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
        if (
            covered_start is not None
            and covered_end is not None
            and covered_start <= frm
            and covered_end >= to
        ):
            return IndexCandleCacheHit(candles=sorted(candles, key=lambda c: c.t_ms))
        return None


def _parse_yyyymmdd(s: str) -> date:
    return date(int(s[:4]), int(s[4:6]), int(s[6:8]))


def _fmt(d: date) -> str:
    return d.strftime("%Y%m%d")


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
        return IndexCandleFetchResult(candles=hit.candles, violations=[])

    existing = cache.list_batches(key)
    fetch_ranges: list[tuple[date, date]] = []
    if existing:
        earliest = min(batch_from for batch_from, _, _ in existing)
        latest = max(batch_to for _, batch_to, _ in existing)
        if frm < earliest:
            fetch_ranges.append((frm, earliest - timedelta(days=1)))
        if latest < to:
            fetch_ranges.append((latest + timedelta(days=1), to))
    else:
        fetch_ranges.append((frm, to))

    violations = []
    for fetch_from, fetch_to in fetch_ranges:
        if fetch_from > fetch_to:
            continue
        result = await fetch_batch(_fmt(fetch_from), _fmt(fetch_to))
        violations.extend(result.violations)
        cache.append_batch(key, fetch_from, fetch_to, result.candles)

    final_hit = cache.covered(key, frm, to)
    candles = final_hit.candles if final_hit is not None else []
    return IndexCandleFetchResult(candles=candles, violations=violations)
