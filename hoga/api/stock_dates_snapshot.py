"""Share inventory computation across tabs without holding up later invalidations."""
from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable


class StockDatesSnapshot:
    def __init__(self) -> None:
        self.key: object = None
        self.payload: bytes | None = None
        self.expires = 0.0
        self.task: asyncio.Task[bytes] | None = None

    async def get(self, key: Callable[[], object], load: Callable[[], Awaitable[bytes]]) -> bytes:
        # One follower refresh handles invalidation during a scan. Do not loop
        # forever when captures keep completing faster than a full scan.
        for attempt in range(2):
            current = key()
            if current is not None and current == self.key and time.monotonic() < self.expires:
                assert self.payload is not None
                return self.payload
            if self.task is None:
                self.task = asyncio.create_task(self._load(current, load))
                # A disconnected caller must neither cancel shared work nor leave
                # a failed task's exception unobserved when it was the last waiter.
                self.task.add_done_callback(lambda task: None if task.cancelled() else task.exception())
            payload = await asyncio.shield(self.task)
            if key() == self.key or attempt:
                return payload
        raise AssertionError("unreachable")

    async def _load(self, key: object, load: Callable[[], Awaitable[bytes]]) -> bytes:
        try:
            payload = await load()
            self.key, self.payload = key, payload
            # Events normally invalidate immediately. Bound missed watcher events
            # as well; this TTL is not the live price freshness policy.
            self.expires = time.monotonic() + 2.0
            return payload
        finally:
            self.task = None
