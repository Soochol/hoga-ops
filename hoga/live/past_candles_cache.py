"""Memory-only cache for KIS minute candle results.

Backs GET /api/live/past-candles. Both past and today's candles live only in
process memory; restart/deploy/eviction is natural invalidation.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.live.kis_venue import KisVenue

_KST = timezone(timedelta(hours=9))
_PAST_ARGS_NO_VENUE = 2
_PAST_ARGS_WITH_VENUE = 3
_TODAY_ARGS_NO_VENUE = 1
_TODAY_ARGS_WITH_VENUE = 2


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")


# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0
# 2048 = _PAST_MAX_DAYS(250) × 2종목 + 60일 워밍 여러 종목 + 여백.
# 512에서는 한 종목 반년 워크백만으로 최근 날짜가 축출돼 60초 refetch가
# 매번 KIS 재호출하는 churn이 생겼다(2026-07-07 실측). 봉당 ~130KB/일
# 기준 최악 ~270MB — 단일 운영 서버에서 수용 가능.
DEFAULT_PAST_MEM_MAX_ENTRIES = 2048
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
        max_today_mem_entries: int = DEFAULT_TODAY_MEM_MAX_ENTRIES,
    ):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        self._max_past_mem_entries = max(0, int(max_past_mem_entries))
        self._max_today_mem_entries = max(0, int(max_today_mem_entries))
        self._past_mem: OrderedDict[tuple[KisVenue, str, str], list[dict]] = OrderedDict()
        self._today_mem: OrderedDict[
            tuple[KisVenue, str],
            tuple[float, list[dict] | None],
        ] = OrderedDict()

    @staticmethod
    def _trim_lru(cache: OrderedDict, max_entries: int) -> None:
        while max_entries >= 0 and len(cache) > max_entries:
            cache.popitem(last=False)

    # --- past ---

    @staticmethod
    def _parse_past_args(args: tuple[str, ...]) -> tuple[KisVenue, str, str]:
        if len(args) == _PAST_ARGS_NO_VENUE:
            code, date = args
            return "KRX", code, date
        if len(args) == _PAST_ARGS_WITH_VENUE:
            venue, code, date = args
            return venue, code, date  # type: ignore[return-value]
        raise TypeError("expected (code, date) or (venue, code, date)")

    @staticmethod
    def _parse_today_args(args: tuple[str, ...]) -> tuple[KisVenue, str]:
        if len(args) == _TODAY_ARGS_NO_VENUE:
            return "KRX", args[0]
        if len(args) == _TODAY_ARGS_WITH_VENUE:
            venue, code = args
            return venue, code  # type: ignore[return-value]
        raise TypeError("expected (code) or (venue, code)")

    def get_past(self, *args: str) -> list[dict] | None:
        venue, code, date = self._parse_past_args(args)
        key = (venue, code, date)
        bars = self._past_mem.get(key)
        if bars is None:
            return None
        if not self._bars_match_date(bars, date):
            self._past_mem.pop(key, None)
            return None
        self._past_mem.move_to_end(key)
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

    def store_past(self, *args) -> None:
        if len(args) == _PAST_ARGS_WITH_VENUE:
            venue, code, date = "KRX", args[0], args[1]
            bars = args[2]
        elif len(args) == _PAST_ARGS_WITH_VENUE + 1:
            venue, code, date, bars = args
        else:
            raise TypeError("expected (code, date, bars) or (venue, code, date, bars)")
        key = (venue, code, date)
        self._past_mem[key] = bars
        self._past_mem.move_to_end(key)
        self._trim_lru(self._past_mem, self._max_past_mem_entries)

    def delete_past(self, *args: str) -> None:
        venue, code, date = self._parse_past_args(args)
        self._past_mem.pop((venue, code, date), None)

    # --- today ---

    def get_today_tri(self, *args: str) -> tuple[TodayState, list[dict] | None]:
        """Tri-state today accessor."""
        venue, code = self._parse_today_args(args)
        entry = self._today_mem.get((venue, code))
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            self._today_mem.pop((venue, code), None)
            return "miss", None
        self._today_mem.move_to_end((venue, code))
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, *args) -> None:
        if len(args) == _TODAY_ARGS_WITH_VENUE:
            venue, code, bars = "KRX", args[0], args[1]
        elif len(args) == _PAST_ARGS_WITH_VENUE:
            venue, code, bars = args
        else:
            raise TypeError("expected (code, bars) or (venue, code, bars)")
        key = (venue, code)
        self._today_mem[key] = (time.monotonic(), bars)
        self._today_mem.move_to_end(key)
        self._trim_lru(self._today_mem, self._max_today_mem_entries)
