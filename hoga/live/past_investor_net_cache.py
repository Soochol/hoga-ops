"""Memory-only cache for KIS investor net-buy results.

Backs GET /api/live/past-investor-net. KIS inquire-investor exposes no
date-range params and returns only the most recent ~30 trading days (one call
per code), so the daily-candle batch/gap machinery (PastDailyCandlesCache) is
unnecessary here — a flat per-code TTL is enough. Empty results are cached too
(negative cache) so a no-data code doesn't re-hit KIS within the TTL window.

Parallel to ADR-0048 (daily cache is memory-only, no disk artifact); process
restart is the natural invalidation event.
"""
from __future__ import annotations

import time
from typing import Literal

TTL_SECONDS = 60.0

CacheState = Literal["hit", "miss"]


class PastInvestorNetCache:
    """In-memory, per-code cache of investor net-buy points with a flat TTL."""

    def __init__(self, *, ttl_seconds: float = TTL_SECONDS) -> None:
        self._ttl = ttl_seconds
        # code -> (fetched_at_monotonic, points)
        self._mem: dict[str, tuple[float, list[dict]]] = {}

    def get(self, code: str) -> tuple[CacheState, list[dict] | None]:
        entry = self._mem.get(code)
        if entry is None:
            return "miss", None
        fetched_at, points = entry
        if time.monotonic() - fetched_at >= self._ttl:
            return "miss", None
        return "hit", points

    def store(self, code: str, points: list[dict]) -> None:
        self._mem[code] = (time.monotonic(), points)
