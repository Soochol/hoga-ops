"""Provisional current-day REST baseline, separate from completed coverage."""
from __future__ import annotations

import asyncio
import time
from collections import OrderedDict

from .kiwoom_us_daily_candles import fetch_stock_daily


class UsStockCurrentDay:
    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.entries = OrderedDict()
        self.pending = {}

    async def get(self, client, scheduler, exchange, symbol, day):
        key = (exchange, symbol, day)
        if key in self.pending:
            await asyncio.shield(self.pending[key])
        elif self.clock() >= self.entries.get(key, (0, None))[0]:
            if key not in self.entries and len(self.pending) >= 64:  # noqa: PLR2004 — bounded in-flight keys
                return None
            if key not in self.entries and len(self.entries) >= 64:  # noqa: PLR2004 — US recent-cache budget
                victim = next((k for k in self.entries if k not in self.pending), None)
                if victim is None:
                    return None
                del self.entries[victim]
            task = asyncio.create_task(self.refresh(key, client, scheduler))
            self.pending[key] = task
            task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            await asyncio.shield(task)
        if key in self.entries:
            self.entries.move_to_end(key)
        return self.entries.get(key, (0, None))[1]

    async def refresh(self, key, client, scheduler):
        try:
            exchange, symbol, day = key
            result = await fetch_stock_daily(client, scheduler, exchange, symbol, day, day,
                                             max_pages=1, adjusted_as_of=day)
            bar = next((b for b in result.bars if b.trading_date == day), None)
            # Failed reads keep this day's last baseline, never yesterday's day.
            if result.messages:
                bar = self.entries.get(key, (0, None))[1]
            self.entries[key] = (self.clock() + 60, bar)
            while len(self.entries) > 64:  # noqa: PLR2004 — completions also enforce the LRU bound
                victim = next(k for k in self.entries if k not in self.pending)
                del self.entries[victim]
        finally:
            self.pending.pop(key, None)

    async def aclose(self):
        tasks = list(self.pending.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.pending.clear()
