"""Memory-only cache for KIS daily OHLCV results.

Backs GET /api/live/past-daily-candles. Daily data is small enough
(~250 KB per code per 20 years) that disk persistence offers no benefit;
process restart is the natural cache invalidation event.

ADR-0048 — parallel to ADR-0040; daily cache lives in memory only and has
no disk artifact. The minute path's PastCandlesCache keeps disk persistence
because 1-minute data at scale exceeds memory.
"""
from __future__ import annotations

import time
from datetime import date, datetime
from typing import Literal

from hoga.live.kis_venue import KIS_KST, KisVenue

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
        self._per_key: dict[tuple[KisVenue, str], list[tuple[date, date, list[dict]]]] = {}
        # value: (fetched_at_monotonic, dict | None)
        self._today_mem: dict[tuple[KisVenue, str], tuple[float, dict | None]] = {}

    # --- batches ---

    @staticmethod
    def _row_date_bounds(bars: list[dict]) -> tuple[date, date] | None:
        dates: list[date] = []
        for bar in bars:
            ts = bar.get("t_ms")
            if isinstance(ts, int):
                dates.append(datetime.fromtimestamp(ts / 1000, tz=KIS_KST).date())
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
    def _parse_code_args(args: tuple[str, ...]) -> tuple[KisVenue, str]:
        if len(args) == 1:
            return "KRX", args[0]
        if len(args) == 2:
            venue, code = args
            return venue, code  # type: ignore[return-value]
        raise TypeError("expected (code) or (venue, code)")

    def list_batches(self, *args: str) -> list[tuple[date, date, list[dict]]]:
        venue, code = self._parse_code_args(args)
        return [
            self._normalize_batch(frm, to, bars)
            for frm, to, bars in self._per_key.get((venue, code), [])
        ]

    def append_batch(
        self, *args,
    ) -> None:
        if len(args) == 4:
            venue, code, frm, to, bars = "KRX", args[0], args[1], args[2], args[3]
        elif len(args) == 5:
            venue, code, frm, to, bars = args
        else:
            raise TypeError("expected (code, frm, to, bars) or (venue, code, frm, to, bars)")
        self._per_key.setdefault((venue, code), []).append(
            self._normalize_batch(frm, to, bars)
        )

    # --- today ---

    def get_today(self, *args: str) -> tuple[TodayState, dict | None]:
        venue, code = self._parse_code_args(args)
        entry = self._today_mem.get((venue, code))
        if entry is None:
            return "miss", None
        fetched_at, value = entry
        if time.monotonic() - fetched_at >= self._today_ttl:
            return "miss", None
        if value is None:
            return "negative", None
        return "hit", value

    def store_today(self, *args) -> None:
        if len(args) == 2:
            venue, code, bar = "KRX", args[0], args[1]
        elif len(args) == 3:
            venue, code, bar = args
        else:
            raise TypeError("expected (code, bar) or (venue, code, bar)")
        self._today_mem[(venue, code)] = (time.monotonic(), bar)
