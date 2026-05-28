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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Literal

from hoga.api._atomic_write import atomic_write_json

_KST = timezone(timedelta(hours=9))


def _ts_ms_to_kst_yyyymmdd(ts_ms: int) -> str:
    return datetime.fromtimestamp(ts_ms / 1000, tz=_KST).strftime("%Y%m%d")

_log = logging.getLogger(__name__)

# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0

# Cache file metadata constant.
_KIS_TR_ID = "FHKST03010230"

TodayState = Literal["hit", "miss", "negative"]


class PastCandlesCache:
    """Disk-backed past + memory-only today cache for KIS minute candles."""

    def __init__(self, data_dir: Path, *, today_ttl_seconds: float = TODAY_TTL_SECONDS):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        # In-memory hot cache for past dates (avoids re-reading disk).
        self._past_mem: dict[tuple[str, str], list[dict]] = {}
        # Today: (code) -> (fetched_at_monotonic, bars-or-None).
        # value=None encodes the negative cache (known non-trading-day today)
        # so a follow-up request within TTL skips KIS.
        self._today_mem: dict[str, tuple[float, list[dict] | None]] = {}

    # --- past ---

    def _past_path(self, code: str, date: str) -> Path:
        return self._data_dir / "kis-past-candles" / code / f"{date}.json"

    def get_past(self, code: str, date: str) -> list[dict] | None:
        key = (code, date)
        if key in self._past_mem:
            bars = self._past_mem[key]
            if not self._bars_match_date(bars, date):
                # In-memory entry is stale (mismatched date). Evict and fall
                # through to disk; disk validation may also reject and trigger
                # a fresh fetch upstream.
                self._past_mem.pop(key, None)
            else:
                return bars
        p = self._past_path(code, date)
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

    def store_past(self, code: str, date: str, bars: list[dict]) -> None:
        p = self._past_path(code, date)
        payload = {
            "candles": bars,
            "fetched_at_ms": int(time.time() * 1000),
            "kis_tr_id": _KIS_TR_ID,
        }
        atomic_write_json(p, payload)
        self._past_mem[(code, date)] = bars

    # --- today ---

    def get_today_tri(self, code: str) -> tuple[TodayState, list[dict] | None]:
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
        entry = self._today_mem.get(code)
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, code: str, bars: list[dict] | None) -> None:
        """Store *bars* (or None for negative cache — non-trading-day today)
        with monotonic-clock TTL stamp."""
        self._today_mem[code] = (time.monotonic(), bars)
