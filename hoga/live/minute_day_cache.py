"""Bounded shared raw day candles. No disk cache and no work on raw ingest.

Keys describe source/venue/day, not an individual scan's cutoff. Packed rows
keep a whole 2,808-stock regular day below 64 MiB; the 96 MiB ceiling also
allows extended-session rows. Old intraday observations are never reconstructed
from a newer partial candle. Invalidation fences in-flight old responses.
"""
from __future__ import annotations

import asyncio
import math
import struct
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime

from hoga.util.timeenc import KST

MINUTE = 60_000
LIVE_TTL_MS = 15_000
SETTLE_MS = 15_000
MAX_BYTES = 96 * 1024 * 1024
MAX_ENTRIES = 8192
_ROW = struct.Struct('<qqddddBB')
_PRICE_FIELDS = ('open', 'high', 'low', 'close')


@dataclass(frozen=True)
class MinuteBar:
    start_ms: int
    volume: int
    is_open: bool = False
    valid: bool = True
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    trade_value_won: float | None = None
    previous_day_close: float | None = None
    previous_day_ms: int | None = None


@dataclass
class MinuteSnapshot:
    bars: list[MinuteBar]
    fetched_at_ms: int
    reason: str | None = None
    chart_bars: list[MinuteBar] | None = None
    cutoff_ms: int | None = None
    response_received_ms: int | None = None


@dataclass(frozen=True)
class Entry:
    rows: bytes
    fetched_ms: int
    cutoff_ms: int
    full_session: bool
    extras: dict
    regular_rows: int
    response_received_ms: int | None = None

    @property
    def weight(self):
        return len(self.rows) + 1024 + len(self.extras) * 256

    def snapshot(self):
        data = []
        for index, (stamp, qty, o, h, low, c, opened, valid) in enumerate(_ROW.iter_unpack(self.rows)):
            prices = {name: None if math.isnan(value) else value
                      for name, value in zip(_PRICE_FIELDS, (o, h, low, c), strict=True)}
            data.append(MinuteBar(stamp, qty, bool(opened), bool(valid), **prices,
                                 **self.extras.get(index, {})))
        regular = [bar for bar in data if regular_minute(bar.start_ms) and bar.start_ms <= self.cutoff_ms]
        return MinuteSnapshot(regular, self.fetched_ms, chart_bars=data if self.full_session else None,
                              cutoff_ms=self.cutoff_ms, response_received_ms=self.response_received_ms)


def regular_minute(stamp):
    clock = datetime.fromtimestamp(stamp / 1000, KST)
    return 900 <= clock.hour * 100 + clock.minute <= 1530  # noqa: PLR2004 — KRX session


def close_ms(day):
    clock = datetime.fromisoformat(str(day)).replace(tzinfo=KST, hour=15, minute=30)
    return int(clock.timestamp() * 1000)


def pack(snapshot, cutoff_ms):
    data = snapshot.chart_bars if snapshot.chart_bars is not None else snapshot.bars
    data = sorted({bar.start_ms: bar for bar in data}.values(), key=lambda bar: bar.start_ms)
    rows, extras = bytearray(), {}
    for index, bar in enumerate(data):
        rows.extend(_ROW.pack(bar.start_ms, bar.volume,
            *(getattr(bar, field) if getattr(bar, field) is not None else math.nan for field in _PRICE_FIELDS),
            bar.is_open, bar.valid))
        extra = {name: getattr(bar, name) for name in ('trade_value_won', 'previous_day_close', 'previous_day_ms')
                 if getattr(bar, name, None) is not None}
        if extra:
            extras[index] = extra
    return Entry(bytes(rows), snapshot.fetched_at_ms, snapshot.cutoff_ms or cutoff_ms,
                 snapshot.chart_bars is not None, extras,
                 sum(regular_minute(bar.start_ms) and bar.start_ms <= (snapshot.cutoff_ms or cutoff_ms)
                     for bar in data), snapshot.response_received_ms)


class MinuteDayCache:
    def __init__(self, *, max_bytes=MAX_BYTES, max_entries=MAX_ENTRIES):
        self.max_bytes, self.max_entries = max_bytes, max_entries
        self.entries = OrderedDict()
        self.flights = {}
        self.serials = {}
        self.bytes = 0
        self.hits = self.misses = self.evictions = 0

    @staticmethod
    def key(data_dir, venue, code, day):
        return data_dir, 'kiwoom-raw-v1', venue, code, datetime.fromisoformat(str(day)).date().isoformat()

    def get(self, key, cutoff_ms, *, now_ms=None, full_session=False, ttl_ms=LIVE_TTL_MS, allow_advance=False):
        entry = self.entries.get(key)
        now_ms = int(time.time() * 1000) if now_ms is None else now_ms
        closing = close_ms(key[-1])
        settled = (not full_session and cutoff_ms >= closing and entry is not None
                   and entry.regular_rows and entry.cutoff_ms >= closing and entry.fetched_ms >= closing + SETTLE_MS)
        if (entry is None or (full_session and not entry.full_session)
                or (entry.cutoff_ms > cutoff_ms and cutoff_ms < closing
                    and not (allow_advance and entry.cutoff_ms <= now_ms))
                or (not settled and now_ms - entry.fetched_ms >= ttl_ms)):
            self.misses += 1
            return None
        self.entries.move_to_end(key)
        self.hits += 1
        return entry.snapshot()

    def put(self, key, snapshot, cutoff_ms):
        if snapshot.reason:
            return
        entry = pack(snapshot, cutoff_ms)
        old = self.entries.get(key)
        if old and (old.cutoff_ms, old.fetched_ms) > (entry.cutoff_ms, entry.fetched_ms):
            return  # Delayed observations never replace a newer live baseline.
        if old:
            self.bytes -= old.weight
        self.entries[key] = entry
        self.entries.move_to_end(key)
        self.bytes += entry.weight
        while self.bytes > self.max_bytes or len(self.entries) > self.max_entries:
            _, evicted = self.entries.popitem(last=False)
            self.bytes -= evicted.weight
            self.evictions += 1

    def invalidate(self, key):
        old = self.entries.pop(key, None)
        if old:
            self.bytes -= old.weight
        # Only keys with a live task need a fence; no unbounded tombstone map.
        if any(flight[0] == key for flight in self.flights):
            self.serials[key] = self.serials.get(key, 0) + 1

    async def obtain(self, key, cutoff_ms, loader, *, force=False, full_session=False,
                     ttl_ms=LIVE_TTL_MS, allow_advance=False):
        if force:
            self.invalidate(key)
        else:
            cached = self.get(key, cutoff_ms, full_session=full_session, ttl_ms=ttl_ms, allow_advance=allow_advance)
            if cached is not None:
                return cached
        serial = self.serials.get(key, 0)
        flight = key, serial
        task = self.flights.get(flight)
        if task is None:
            task = asyncio.create_task(self._load(flight, key, serial, cutoff_ms, loader))
            self.flights[flight] = task
            task.add_done_callback(lambda done: done.exception() if not done.cancelled() else None)
        result = await asyncio.shield(task)
        if full_session and result.chart_bars is None:
            return await loader()
        # An older in-flight request can end before this caller's cutoff. It is
        # safe to reuse its older observation, never a future partial value.
        if (not allow_advance and result.cutoff_ms is not None and result.cutoff_ms > cutoff_ms
                and cutoff_ms < close_ms(key[-1])):
            return await loader()  # Historical read keeps its own cutoff contract.
        return result

    async def _load(self, flight, key, serial, cutoff_ms, loader):
        try:
            result = await loader()
            if self.serials.get(key, 0) == serial:
                self.put(key, result, cutoff_ms)
            return result
        finally:
            self.flights.pop(flight, None)
            if not any(item[0] == key for item in self.flights):
                self.serials.pop(key, None)

    def clear(self):
        for key in set(self.entries) | {flight[0] for flight in self.flights}:
            self.invalidate(key)
        self.bytes = 0
        self.hits = self.misses = self.evictions = 0


shared_days = MinuteDayCache()
