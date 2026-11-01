"""Synthetic shared-day call counts and notification CPU; never contacts a broker.

Run: uv run python tools/measure_screener_minute_cache.py
Results do not measure complete query, network or browser latency.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import json
import statistics
import time
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hoga.api import screener_bar_volume as volume
from hoga.api.models import ScanRequest
from hoga.api.screener_continuous import ContinuousMonitors, History
from hoga.api.screener_minute_scope import MinuteScope, bind
from hoga.live.minute_day_cache import shared_days
from hoga.live.volume_state import VolumeReplica
from hoga.util.timeenc import KST

DAY = dt.date(2026, 10, 30)
CLOSE = dt.datetime.combine(DAY, dt.time(15, 30), KST)
OPEN = int(dt.datetime.combine(DAY, dt.time(9), KST).timestamp()*1000)
RAW_BARS = 140


async def calls_measurement(symbols=2808):
    calls = 0
    shared_days.clear()
    bars = [volume.VolumeBar(OPEN+i*60_000, i+1, open=10, high=12, low=9, close=11) for i in range(391)]
    async def fetch(*_args):
        nonlocal calls
        calls += 1
        return volume.MinuteSnapshot(bars, int(time.time()*1000), chart_bars=bars)
    async def scan():
        before = calls
        for offset in range(0, symbols, 64):
            scope = MinuteScope(DAY, CLOSE)
            with bind(scope):
                for code in range(offset, min(offset+64, symbols)):
                    for timeframe in ('3m', '5m', '10m'):
                        await volume._day_snapshot(Path('/tmp/hoga-minute-cache-benchmark'),
                                                   f'{code:06d}', timeframe, scope)
        return calls-before
    with (patch.object(volume, '_fetch_minutes', fetch),
          patch.object(volume.settings, 'rest_bypass_enabled', lambda _: False)):
        first, repeat = await scan(), await scan()
    assert first == symbols and repeat == 0
    return dict(symbols=symbols, timeframes=['3m','5m','10m'], first_calls=first, repeat_calls=repeat,
        cache_entries=len(shared_days.entries), reserved_cache_bytes=shared_days.bytes,
        baseline_independent_timeframe_calls=symbols*3)


def cpu_measurement(symbols=338):
    now = int(dt.datetime.combine(DAY, dt.time(15), KST).timestamp()*1000)+20_000
    req = ScanRequest.model_validate(dict(conditions=[dict(id=tf, type='new_high_vol', params=dict(
        timeframe=tf, period=period, lookback=3)) for tf, period in [('3m',40),('5m',24),('10m',12)]],
        universe=dict(scopes=['watchlist','heatmap']), basis='intraday'))
    owner = ContinuousMonitors(Path('/tmp/hoga-minute-cache-benchmark'), None,
        SimpleNamespace(volume_replica=VolumeReplica()), None, now=lambda: now)
    data = [volume.VolumeBar(now//60_000*60_000-(RAW_BARS-1-i)*60_000, i+1, i == RAW_BARS-1)
            for i in range(RAW_BARS)]
    codes = [f'{i:06d}' for i in range(symbols)]
    owner.histories = {code: History(139, bars=list(data), fetched_ms=now) for code in codes}
    monitor = SimpleNamespace(id='bench', codes=codes, leaves=req.conditions, fingerprint=())
    owner.monitors[monitor.id] = monitor
    owner.notify()
    def full():
        return [owner.match_fingerprint(monitor, history, now) for history in owner.histories.values()]
    def dirty():
        history = owner.histories[codes[0]]
        history.bars[-1] = replace(history.bars[-1], volume=history.bars[-1].volume+1)
        history.revision += 1
        owner.notify()
    def measure(fn):
        times = []
        for _ in range(12):
            began = time.perf_counter()
            fn()
            times.append((time.perf_counter()-began)*1000)
        return round(statistics.median(times), 3)
    return dict(symbols=symbols, conditions=3, full_fingerprint_ms=measure(full),
        unchanged_notification_ms=measure(owner.notify), one_changed_notification_ms=measure(dirty),
        note='CPU only; complete scan, transport, rendering and busy all-symbol ticks excluded')


if __name__ == '__main__':
    print(json.dumps(dict(calls=asyncio.run(calls_measurement()), cpu=cpu_measurement()), indent=2))
