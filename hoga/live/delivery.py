"""Bounded live delivery: latest state is independent of the ordered history tail.

History loss is explicit. A REST refresh cannot promise to recover evicted raw
ticks, so consumers must retain the partial-history flag until a new session.
"""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict, deque

from .latency import LatencySamples

BATCH_SIZE = 128
HISTORY_CAPACITY = 1024


class LiveDelivery:
    def __init__(self, capacity: int = HISTORY_CAPACITY) -> None:
        self._history: deque[tuple[float, dict]] = deque(maxlen=capacity)
        self._latest: dict[tuple[str, str], dict] = {}
        self._wake = asyncio.Event()
        self._dropped = 0
        self.dropped_total = 0

    def put_nowait(self, entry: dict) -> None:
        if len(self._history) == self._history.maxlen:
            self._dropped += 1
            self.dropped_total += 1
        self._history.append((time.monotonic(), entry))
        key = (entry.get("venue") or "KRX", entry["kind"])
        previous = self._latest.get(key)
        if previous is None or entry["seq"] >= previous["seq"]:
            self._latest[key] = entry
        self._wake.set()

    def merge(self, batch: dict) -> None:
        for entry in batch["data"]:
            self.put_nowait(entry)
        # A later history batch may contain old entries; compare publication
        # sequence, not HHMMSS, which isn't unique and can arrive out of order.
        for entry in batch["latest"]:
            key = (entry.get("venue") or "KRX", entry["kind"])
            previous = self._latest.get(key)
            if previous is None or entry["seq"] >= previous["seq"]:
                self._latest[key] = entry
        self._dropped += batch["dropped"]
        self.dropped_total += batch["dropped"]

    def empty(self) -> bool:
        return not self._history

    def take(self) -> dict:
        age_ms = (time.monotonic() - self._history[0][0]) * 1000 if self._history else 0
        entries = [self._history.popleft()[1]
                   for _ in range(min(BATCH_SIZE, len(self._history)))]
        latest = list(self._latest.values())
        dropped, self._dropped = self._dropped, 0
        self._latest.clear()
        if not self._history:
            self._wake.clear()
        return {"data": entries, "latest": latest, "dropped": dropped, "queue_age_ms": age_ms}

    async def get(self) -> dict:
        await self._wake.wait()
        return self.take()


class LiveOutbox:
    """One pending token per code, round-robin history batches, bounded controls."""
    def __init__(self, maxsize: int = 2048) -> None:
        self._controls: asyncio.Queue[dict] = asyncio.Queue(maxsize=maxsize)
        self._live: OrderedDict[str, LiveDelivery] = OrderedDict()
        self._wake = asyncio.Event()
        self._control_turn = True
        self.queue_latency = LatencySamples()
        self.send_latency = LatencySamples()
        self.history_drops = 0

    def put_nowait(self, frame: dict) -> None:
        self._controls.put_nowait(frame)
        self._wake.set()

    def offer(self, code: str, batch: dict) -> None:
        delivery = self._live.setdefault(code, LiveDelivery())
        before = delivery.dropped_total
        delivery.merge(batch)
        self.history_drops += delivery.dropped_total - before
        self._wake.set()

    def discard(self, code: str) -> None:
        self._live.pop(code, None)

    async def get(self) -> dict:
        while True:
            await self._wake.wait()
            if not self._controls.empty() and (self._control_turn or not self._live):
                self._control_turn = False
                return self._controls.get_nowait()
            if self._live:
                code, delivery = self._live.popitem(last=False)
                batch = delivery.take()
                self.queue_latency.observe(batch["queue_age_ms"])
                if not delivery.empty():
                    self._live[code] = delivery
                self._control_turn = True
                return {"ch": "live_batch", "code": code, **batch}
            self._wake.clear()

    def snapshot(self) -> dict:
        return {
            "queued_codes": len(self._live),
            "queued_controls": self._controls.qsize(),
            "history_drops": self.history_drops,
            "queue": self.queue_latency.snapshot(),
            "send": self.send_latency.snapshot(),
        }
