"""A bounded loop-turn marker for one reader/consumer's cooperative work slice.

An async callback may finish synchronously or suspend. One call_soon marker per
slice distinguishes those cases without wrapping/driving somebody else's coroutine
or creating a task per tick. At a checkpoint after a suspension, start a new slice;
waiting for the event loop is not work performed by this consumer.

This is a cooperative wall-time budget, not per-task CPU accounting. An atomic
callback cannot be preempted, and work inside that callback after its last await
cannot be timed independently. No guarantee is made about one callback's duration.
"""
from __future__ import annotations

import asyncio
import time
from collections.abc import Callable


class LoopWorkBudget:
    def __init__(self, interval_s: float, clock: Callable[[], float] = time.monotonic) -> None:
        self._interval_s = interval_s
        self._clock = clock
        self._started_at = clock()
        self._suspended = False
        self._marker: asyncio.Handle | None = None
        self.yields = 0
        self.observed_resumes = 0
        self.yield_wait_ms = 0.0
        self._arm()

    def _arm(self) -> None:
        if self._marker is None:
            self._marker = asyncio.get_running_loop().call_soon(self._on_loop_turn)

    def _on_loop_turn(self) -> None:
        self._marker = None
        self._suspended = True

    async def checkpoint(self) -> None:
        now = self._clock()
        if self._suspended:
            self.observed_resumes += 1
            self._started_at = now
            self._suspended = False
            self._arm()
        if now - self._started_at < self._interval_s:
            return
        started = self._clock()
        self.yields += 1
        await asyncio.sleep(0)
        now = self._clock()
        self.yield_wait_ms += max(0.0, (now - started) * 1000)
        self._started_at = now
        self._suspended = False
        self._arm()

    def snapshot(self) -> dict:
        return {"yields": self.yields, "observed_resumes": self.observed_resumes,
                "yield_wait_ms": round(self.yield_wait_ms, 1)}

    def close(self) -> None:
        if self._marker is not None:
            self._marker.cancel()
            self._marker = None

    def __enter__(self) -> LoopWorkBudget:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()
