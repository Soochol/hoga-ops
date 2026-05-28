"""Memory-only cache for KIS daily OHLCV results.

Backs GET /api/live/past-daily-candles. Daily data is small enough
(~250 KB per code per 20 years) that disk persistence offers no benefit;
process restart is the natural cache invalidation event.

ADR-0047 — parallel to ADR-0040; daily cache lives in memory only and has
no disk artifact. The minute path's PastCandlesCache keeps disk persistence
because 1-minute data at scale exceeds memory.
"""
from __future__ import annotations

import time
from datetime import date
from typing import Literal

# TTL for today's bar (and negative cache for non-trading-day today).
TODAY_TTL_SECONDS = 60.0

TodayState = Literal["hit", "miss", "negative"]


class PastDailyCandlesCache:
    """In-memory cache for KIS daily candles.

    - Past batches: per-code list of (from_date, to_date, bars) in insertion order.
    - Today: per-code tri-state — "hit" (dict), "miss" (no entry / TTL expired),
      "negative" (fetched, no data — non-trading day).
    """

    def __init__(self, *, today_ttl_seconds: float = TODAY_TTL_SECONDS) -> None:
        self._today_ttl = today_ttl_seconds
        self._per_code: dict[str, list[tuple[date, date, list[dict]]]] = {}
        # value: (fetched_at_monotonic, dict | None)
        self._today_mem: dict[str, tuple[float, dict | None]] = {}

    # --- batches ---

    def list_batches(self, code: str) -> list[tuple[date, date, list[dict]]]:
        return list(self._per_code.get(code, []))

    def append_batch(
        self, code: str, frm: date, to: date, bars: list[dict],
    ) -> None:
        self._per_code.setdefault(code, []).append((frm, to, bars))

    # --- today ---

    def get_today(self, code: str) -> tuple[TodayState, dict | None]:
        entry = self._today_mem.get(code)
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, code: str, bar: dict | None) -> None:
        self._today_mem[code] = (time.monotonic(), bar)
