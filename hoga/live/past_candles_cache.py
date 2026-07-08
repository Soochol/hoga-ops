"""Memory-only cache for KIS minute candle results.

Backs GET /api/live/past-candles. Both past and today's candles live only in
process memory; restart/deploy/eviction is natural invalidation.

past 계층은 코드-지역성 2단 LRU: (venue, code) 코드-LRU 아래에 date-LRU.
전역 예산 초과 시 LRU '코드'의 가장 오래된 날짜부터 축출한다 — 단일 전역
날짜-LRU에서는 관심종목 순환이 딥스크롤 중인 활성 코드의 창을 밀어내
같은 날짜를 세션 중 수십 회 재fetch하는 churn이 있었다.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.live.kis_venue import KisVenue
from hoga.util.cache_stats import CacheStats

_KST = timezone(timedelta(hours=9))


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")


# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0
# 전역 예산 2048 = 워크백 250거래일 × 2종목 + 60일 워밍 여러 종목 + 여백
# (ADR-0091 사이징). 봉당 ~130KB/일 기준 최악 ~270MB — 단일 운영 서버에서
# 수용 가능(ADR-0036). 코드-지역성 2단 구조가 512 시절의 축출 churn
# (한 종목 반년 워크백만으로 최근 날짜 축출 → 60초 refetch가 매번 KIS
# 재호출, 2026-07-07 실측)을 구조적으로 막고, 이 예산은 총량 상한이다.
DEFAULT_PAST_MEM_MAX_ENTRIES = 2048
# per-code 쿼터: ADR-0090 read-ahead 클램프(243캘린더일) + 여유.
DEFAULT_PAST_MAX_DATES_PER_CODE = 320
DEFAULT_TODAY_MEM_MAX_ENTRIES = 256

TodayState = Literal["hit", "miss", "negative"]


class PastCandlesCache:
    """Memory-only cache for KIS minute candles."""

    def __init__(
        self,
        data_dir: Path,
        *,
        today_ttl_seconds: float = TODAY_TTL_SECONDS,
        max_past_mem_entries: int = DEFAULT_PAST_MEM_MAX_ENTRIES,
        max_past_dates_per_code: int = DEFAULT_PAST_MAX_DATES_PER_CODE,
        max_today_mem_entries: int = DEFAULT_TODAY_MEM_MAX_ENTRIES,
    ):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        self._max_past_mem_entries = max(0, int(max_past_mem_entries))
        self._max_past_dates_per_code = max(0, int(max_past_dates_per_code))
        self._max_today_mem_entries = max(0, int(max_today_mem_entries))
        self._past_mem: OrderedDict[
            tuple[KisVenue, str], OrderedDict[str, list[dict]]
        ] = OrderedDict()
        self._past_total = 0
        self._today_mem: OrderedDict[
            tuple[KisVenue, str],
            tuple[float, list[dict] | None],
        ] = OrderedDict()
        self._past_stats = CacheStats()
        self._today_stats = CacheStats()

    # --- past ---

    def past_entry_count(self) -> int:
        return self._past_total

    def stats_snapshot(self) -> dict[str, dict[str, int | float | None]]:
        return {
            "past": self._past_stats.snapshot(size=self._past_total),
            "today": self._today_stats.snapshot(size=len(self._today_mem)),
        }

    def get_past(self, venue: KisVenue, code: str, date: str) -> list[dict] | None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            self._past_stats.record_miss()
            return None
        bars = inner.get(date)
        if bars is None:
            self._past_stats.record_miss()
            return None
        if not self._bars_match_date(bars, date):
            # Stale entry (wrong-date rows) — a correctness invalidation, not LRU
            # pressure, so drop it without counting an eviction (advisor #3).
            self._drop_date(key, inner, date)
            self._past_stats.record_miss()
            return None
        inner.move_to_end(date)
        self._past_mem.move_to_end(key)
        self._past_stats.record_hit()
        return bars

    @staticmethod
    def _bars_match_date(bars: list[dict], date_yyyymmdd: str) -> bool:
        """True if `bars` is empty or first bar `t_ms` matches requested date."""
        if not bars:
            return True
        first_ts = bars[0].get("t_ms")
        if not isinstance(first_ts, int):
            return False
        return _ts_ms_to_kst_yyyymmdd(first_ts) == date_yyyymmdd

    def store_past(
        self, venue: KisVenue, code: str, date: str, bars: list[dict]
    ) -> None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            inner = OrderedDict()
            self._past_mem[key] = inner
        if date not in inner:
            self._past_total += 1
        inner[date] = bars
        inner.move_to_end(date)
        self._past_mem.move_to_end(key)
        self._past_stats.record_store()
        # ① per-code 쿼터: 자기 자신의 oldest부터.
        while len(inner) > self._max_past_dates_per_code:
            inner.popitem(last=False)
            self._past_total -= 1
            self._past_stats.record_eviction()
        if not inner:
            self._past_mem.pop(key, None)
        # ② 전역 예산: LRU 코드의 oldest부터 (방금 저장한 코드는 MRU라 보호).
        while self._past_total > self._max_past_mem_entries and self._past_mem:
            lru_key, lru_inner = next(iter(self._past_mem.items()))
            lru_inner.popitem(last=False)
            self._past_total -= 1
            self._past_stats.record_eviction()
            if not lru_inner:
                del self._past_mem[lru_key]

    def delete_past(self, venue: KisVenue, code: str, date: str) -> None:
        key = (venue, code)
        inner = self._past_mem.get(key)
        if inner is None:
            return
        if date in inner:
            self._drop_date(key, inner, date)

    def _drop_date(
        self, key: tuple[KisVenue, str], inner: OrderedDict, date: str
    ) -> None:
        inner.pop(date, None)
        self._past_total -= 1
        if not inner:
            self._past_mem.pop(key, None)

    # --- today ---

    def get_today_tri(
        self, venue: KisVenue, code: str
    ) -> tuple[TodayState, list[dict] | None]:
        """Tri-state today accessor."""
        entry = self._today_mem.get((venue, code))
        if entry is None:
            self._today_stats.record_miss()
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            self._today_mem.pop((venue, code), None)
            self._today_stats.record_miss()
            return "miss", None
        self._today_mem.move_to_end((venue, code))
        if value is None:
            self._today_stats.record_negative()
            return "negative", None
        self._today_stats.record_hit()
        return "hit", value

    def store_today(
        self, venue: KisVenue, code: str, bars: list[dict] | None
    ) -> None:
        key = (venue, code)
        self._today_mem[key] = (time.monotonic(), bars)
        self._today_mem.move_to_end(key)
        while len(self._today_mem) > self._max_today_mem_entries:
            self._today_mem.popitem(last=False)
