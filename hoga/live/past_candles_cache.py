"""Disk + memory hybrid cache for KIS dailychartprice candle results.

Backs the GET /api/live/past-candles endpoint. Past dates (date < today_kst)
are persisted under <data_dir>/kis-past-candles/<code>/<YYYYMMDD>.json with
atomic write semantics. Today's candles live only in memory with a configurable
TTL (default 60s).

Cache file format (versionable):
    {
        "candles": [{t_ms, open, high, low, close, volume}, ...],
        "fetched_at_ms": int,
        "kis_tr_id": "FHKST03010230",
    }

ADR-0040 — separate cache namespace from kis_live promoted Parquet.
"""
from __future__ import annotations

import json
import logging
import time
from collections import OrderedDict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.api._atomic_write import atomic_write_json
from hoga.live.kis_venue import KisVenue

_KST = timezone(timedelta(hours=9))


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")

_log = logging.getLogger(__name__)

# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0
DEFAULT_PAST_MEM_MAX_ENTRIES = 512
DEFAULT_TODAY_MEM_MAX_ENTRIES = 256

# Cache file metadata constant.
_KIS_TR_ID = "FHKST03010230"

TodayState = Literal["hit", "miss", "negative"]


class PastCandlesCache:
    """Disk-backed past + memory-only today cache for KIS minute candles."""

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
        # In-memory hot cache for past dates (avoids re-reading disk).
        self._past_mem: OrderedDict[tuple[KisVenue, str, str], list[dict]] = OrderedDict()
        # Today: (venue, code) -> (fetched_at_monotonic, bars-or-None).
        # value=None encodes the negative cache (known non-trading-day today)
        # so a follow-up request within TTL skips KIS.
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
        if len(args) == 2:
            code, date = args
            return "KRX", code, date
        if len(args) == 3:
            venue, code, date = args
            return venue, code, date  # type: ignore[return-value]
        raise TypeError("expected (code, date) or (venue, code, date)")

    @staticmethod
    def _parse_today_args(args: tuple[str, ...]) -> tuple[KisVenue, str]:
        if len(args) == 1:
            return "KRX", args[0]
        if len(args) == 2:
            venue, code = args
            return venue, code  # type: ignore[return-value]
        raise TypeError("expected (code) or (venue, code)")

    def _past_path(self, venue: KisVenue, code: str, date: str) -> Path:
        if venue == "KRX":
            return self._data_dir / "kis-past-candles" / code / f"{date}.json"
        return self._data_dir / "kis-past-candles" / venue / code / f"{date}.json"

    def get_past(self, *args: str) -> list[dict] | None:
        venue, code, date = self._parse_past_args(args)
        key = (venue, code, date)
        if key in self._past_mem:
            bars = self._past_mem[key]
            if not self._bars_match_date(bars, date):
                # In-memory entry is stale (mismatched date). Evict and fall
                # through to disk; disk validation may also reject and trigger
                # a fresh fetch upstream.
                self._past_mem.pop(key, None)
            else:
                self._past_mem.move_to_end(key)
                return bars
        p = self._past_path(venue, code, date)
        if not p.exists():
            return None
        try:
            body = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            # Treat corrupt or unreadable cache as miss. Log so operators can
            # see silent recovery; the next store_past will heal the file.
            _log.warning("past_candles_cache.corrupt_or_unreadable path=%s", p, exc_info=True)
            return None
        bars = body.get("candles") or []
        if not self._bars_match_date(bars, date):
            # KIS dailychartprice quirk (pre-fix f63ed15): non-trading-day
            # queries returned the prior trading day's bars and were cached
            # under the queried date. Evict the stale file so the upstream
            # fetcher (now guarded) writes a correct empty/fresh result.
            _log.warning(
                "past_candles_cache.stale_disk_evicting path=%s reason=date_mismatch",
                p,
            )
            try:
                p.unlink()
            except OSError:
                pass
            return None
        self._past_mem[key] = bars
        self._past_mem.move_to_end(key)
        self._trim_lru(self._past_mem, self._max_past_mem_entries)
        return bars

    @staticmethod
    def _bars_match_date(bars: list[dict], date_yyyymmdd: str) -> bool:
        """True if `bars` is empty (legitimately a non-trading day) or its first
        bar's `t_ms` falls within the requested KST date. Used to detect cache
        files corrupted by the pre-f63ed15 KIS quirk where a non-trading-day
        query returned the prior trading day's bars."""
        if not bars:
            return True
        first_ts = bars[0].get("t_ms")
        if not isinstance(first_ts, int):
            return False
        return _ts_ms_to_kst_yyyymmdd(first_ts) == date_yyyymmdd

    def store_past(self, *args) -> None:
        if len(args) == 3:
            venue, code, date = "KRX", args[0], args[1]
            bars = args[2]
        elif len(args) == 4:
            venue, code, date, bars = args
        else:
            raise TypeError("expected (code, date, bars) or (venue, code, date, bars)")
        p = self._past_path(venue, code, date)
        payload = {
            "candles": bars,
            "fetched_at_ms": int(time.time() * 1000),
            "kis_tr_id": _KIS_TR_ID,
            "kis_venue": venue,
        }
        atomic_write_json(p, payload)
        self._past_mem[(venue, code, date)] = bars
        self._past_mem.move_to_end((venue, code, date))
        self._trim_lru(self._past_mem, self._max_past_mem_entries)

    def delete_past(self, *args: str) -> None:
        venue, code, date = self._parse_past_args(args)
        self._past_mem.pop((venue, code, date), None)
        try:
            self._past_path(venue, code, date).unlink()
        except FileNotFoundError:
            pass
        except OSError:
            _log.warning(
                "past_candles_cache.delete_failed venue=%s code=%s date=%s",
                venue,
                code,
                date,
                exc_info=True,
            )

    # --- today ---

    def get_today_tri(self, *args: str) -> tuple[TodayState, list[dict] | None]:
        """Tri-state today accessor.

        Returns:
        - ("hit", bars) when within TTL and bars were stored.
        - ("negative", None) when within TTL and store_today(code, None) was
          called (known non-trading day; skip KIS for TTL window).
        - ("miss", None) when no entry or TTL expired.

        Callers MUST handle all three states. The legacy two-state get_today
        was removed because it conflated "miss" and "negative", defeating the
        negative-cache invariant.
        """
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
        """Store *bars* (or None for negative cache — non-trading-day today)
        with monotonic-clock TTL stamp."""
        if len(args) == 2:
            venue, code, bars = "KRX", args[0], args[1]
        elif len(args) == 3:
            venue, code, bars = args
        else:
            raise TypeError("expected (code, bars) or (venue, code, bars)")
        key = (venue, code)
        self._today_mem[key] = (time.monotonic(), bars)
        self._today_mem.move_to_end(key)
        self._trim_lru(self._today_mem, self._max_today_mem_entries)
