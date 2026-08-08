"""Memory-only cache for KIS daily OHLCV results.

Backs GET /api/live/past-daily-candles. Daily data is small enough
(~250 KB per code per 20 years) that disk persistence offers no benefit;
process restart is the natural cache invalidation event.

ADR-0048 — parallel to ADR-0040; daily cache lives in memory only and has
no disk artifact. The minute path's `PastCandlesCache` is also memory-only in
this branch; historical `kis-past-candles/<code>/<date>.json` files are legacy
artifacts, not runtime cache.
"""
from __future__ import annotations

import time
from datetime import date, datetime
from typing import Literal

from hoga.live.venue import Venue
from hoga.util.cache_primitives import LruDict, TtlTriStateCache
from hoga.util.cache_stats import CacheStats
from hoga.util.timeenc import KST


def _monotonic() -> float:
    # Late lookup through THIS module's `time` so the golden test's
    # `past_daily_candles_cache.time.monotonic` patch is observed (a captured
    # bound method would not be).
    return time.monotonic()


# TTL for today's bar (and negative cache for non-trading-day today).
TODAY_TTL_SECONDS = 60.0
DEFAULT_PAST_KEY_MAX_ENTRIES = 256
DEFAULT_TODAY_KEY_MAX_ENTRIES = 256

TodayState = Literal["hit", "miss", "negative"]


class PastDailyCandlesCache:
    """In-memory cache for KIS daily candles.

    - Past batches: per-code list of (from_date, to_date, bars) in insertion order.
    - Today: per-code tri-state — "hit" (dict), "miss" (no entry / TTL expired),
      "negative" (fetched, no data — non-trading day).
    """

    def __init__(
        self,
        *,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        max_past_keys: int = DEFAULT_PAST_KEY_MAX_ENTRIES,
        max_today_keys: int = DEFAULT_TODAY_KEY_MAX_ENTRIES,
    ) -> None:
        self._batch_stats = CacheStats()
        self._today_stats = CacheStats()
        # Dual-horizon primitives (ADR-0092). `_per_key` / `_today_mem` names are
        # kept so existing introspection (`key in cache._per_key`) and the
        # `past_daily_candles_cache.time.monotonic` patch seam still resolve; the
        # today clock is a module-local late lookup so that patch is observed.
        self._per_key: LruDict[
            tuple[Venue, str], list[tuple[date, date, list[dict]]]
        ] = LruDict(max_past_keys, stats=self._batch_stats)
        self._today_mem: TtlTriStateCache[tuple[Venue, str], dict] = TtlTriStateCache(
            today_ttl_seconds,
            max_today_keys,
            clock=_monotonic,
            stats=self._today_stats,
        )

    def stats_snapshot(self) -> dict[str, dict[str, int | float | None]]:
        return {
            "batches": self._batch_stats.snapshot(size=len(self._per_key)),
            "today": self._today_stats.snapshot(size=len(self._today_mem)),
        }

    # --- batches ---

    @staticmethod
    def _row_date_bounds(bars: list[dict]) -> tuple[date, date] | None:
        dates: list[date] = []
        for bar in bars:
            ts = bar.get("t_ms")
            if isinstance(ts, int):
                dates.append(datetime.fromtimestamp(ts / 1000, tz=KST).date())
        if not dates:
            return None
        return min(dates), max(dates)

    @classmethod
    def _normalize_batch(
        cls, frm: date, to: date, bars: list[dict],
    ) -> tuple[date, date, list[dict]]:
        row_bounds = cls._row_date_bounds(bars)
        if row_bounds is None:
            return frm, to, bars
        row_from, row_to = row_bounds
        return max(frm, row_from), min(to, row_to), bars

    @staticmethod
    def _parse_code_args(args: tuple[str, ...]) -> tuple[Venue, str]:
        if len(args) == 1:
            return "KRX", args[0]
        if len(args) == 2:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            venue, code = args
            return venue, code  # type: ignore[return-value]
        raise TypeError("expected (code) or (venue, code)")

    def list_batches(self, *args: str) -> list[tuple[date, date, list[dict]]]:
        venue, code = self._parse_code_args(args)
        key = (venue, code)
        batches = self._per_key.get(key, [])
        if key in self._per_key:
            self._per_key.move_to_end(key)
            self._batch_stats.record_hit()
        else:
            self._batch_stats.record_miss()
        return [
            self._normalize_batch(frm, to, bars)
            for frm, to, bars in (batches or [])
        ]

    def clear_batches(self) -> None:
        """과거 배치를 전부 버린다. 오늘 슬롯(TTL tri-state)은 건드리지 않는다.

        **수정주가 기준일이 바뀔 때** 쓴다(#1228 함정 ④). 배치는 기준일 시점의
        척도로 굳어 있는데, 그 사이 액면분할이 나면 새로 받는 배치와 척도가
        갈린다. 배치마다 기준일을 기억하는 대신 통째로 버리는 이유는 기준일이
        **전역으로 하나**(오늘)라 부분 무효화할 축이 없기 때문이다.
        """
        self._per_key.clear()

    def append_batch(
        self, *args,
    ) -> None:
        if len(args) == 4:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            venue, code, frm, to, bars = "KRX", args[0], args[1], args[2], args[3]
        elif len(args) == 5:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            venue, code, frm, to, bars = args
        else:
            raise TypeError("expected (code, frm, to, bars) or (venue, code, frm, to, bars)")
        key = (venue, code)
        self._per_key.setdefault(key, list).append(
            self._normalize_batch(frm, to, bars)
        )
        self._per_key.move_to_end(key)
        self._batch_stats.record_store()
        self._per_key.trim()

    # --- today ---

    def get_today(self, *args: str) -> tuple[TodayState, dict | None]:
        venue, code = self._parse_code_args(args)
        # TtlTriStateCache records hit/miss/negative on _today_stats internally.
        return self._today_mem.get((venue, code))

    def store_today(self, *args) -> None:
        if len(args) == 2:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            venue, code, bar = "KRX", args[0], args[1]
        elif len(args) == 3:  # noqa: PLR2004 — 국소 비교 상수 — 이름을 붙여도 의미가 늘지 않는 자리
            venue, code, bar = args
        else:
            raise TypeError("expected (code, bar) or (venue, code, bar)")
        self._today_mem.store((venue, code), bar)
