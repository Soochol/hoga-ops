"""Per-key asyncio single-flight gate for the daily KIS walk-back endpoints.

Motivation (2026-07-09): on a cold process the `/past-daily-candles` and
`/past-investor-net` endpoints memory-cache their KIS results, but the cache is
only populated *after* a gap fetch completes. When the frontend fires several
overlapping requests for the same code at once — e.g. code 489790 with
``from=20010809 / 20100325 / 20140123 / 20171123`` all to today — every request
sees an empty cache, computes the full gap, and independently walks KIS back up
to ~60 pages. Because those ranges all end today (shorter ⊂ longer), the fetched
data is identical, so N requests do N×60 background calls for 60 calls' worth of
data. On the background lane (which yields to foreground, ~1.5s/page backstop)
this stacks to the observed 60–100s per request.

``SingleFlight`` serialises same-key callers: the first runs the cold walk-back
and fills the shared cache; followers wait, then re-read the now-warm cache and
issue zero upstream calls. The lock is held only for the walk-back itself, so in
steady state (warm cache) it is a sub-millisecond hop.
"""
from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Hashable
from contextlib import asynccontextmanager


class SingleFlight:
    """Serialise concurrent callers that share a key.

    One lock per key, created lazily. ``acquire`` does no ``await`` before it
    reads/creates the lock, so the get-or-create is atomic on the single event
    loop — concurrent acquirers for the same key always observe one lock.

    The lock registry is unbounded but bounded in practice: keys are
    ``code`` / ``(venue, code)`` drawn from the validated symbol universe
    (~thousands of codes × a few venues), each holding one tiny ``asyncio.Lock``.
    """

    def __init__(self) -> None:
        self._locks: dict[Hashable, asyncio.Lock] = {}

    @asynccontextmanager
    async def acquire(self, key: Hashable) -> AsyncIterator[None]:
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        async with lock:
            yield
