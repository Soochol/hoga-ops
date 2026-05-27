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
from pathlib import Path

from hoga.api._atomic_write import atomic_write_json

_log = logging.getLogger(__name__)

# Default TTL for today's memory cache.
TODAY_TTL_SECONDS = 60.0

# Cache file metadata constant.
_KIS_TR_ID = "FHKST03010230"


class PastCandlesCache:
    """Disk-backed past + memory-only today cache for KIS minute candles."""

    def __init__(self, data_dir: Path, *, today_ttl_seconds: float = TODAY_TTL_SECONDS):
        self._data_dir = data_dir
        self._today_ttl = today_ttl_seconds
        # In-memory hot cache for past dates (avoids re-reading disk).
        self._past_mem: dict[tuple[str, str], list[dict]] = {}
        # Today: (code) -> (fetched_at_monotonic, bars).
        self._today_mem: dict[str, tuple[float, list[dict]]] = {}

    # --- past ---

    def _past_path(self, code: str, date: str) -> Path:
        return self._data_dir / "kis-past-candles" / code / f"{date}.json"

    def get_past(self, code: str, date: str) -> list[dict] | None:
        key = (code, date)
        if key in self._past_mem:
            return self._past_mem[key]
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
        self._past_mem[key] = bars
        return bars

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

    def get_today(self, code: str) -> list[dict] | None:
        entry = self._today_mem.get(code)
        if entry is None:
            return None
        fetched_at, bars = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return None
        return bars

    def store_today(self, code: str, bars: list[dict]) -> None:
        self._today_mem[code] = (time.monotonic(), bars)
