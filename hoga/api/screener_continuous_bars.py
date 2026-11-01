"""Derive scoped 3/5/10-minute volume candles from one shared 1-minute history."""
from dataclasses import replace
from datetime import datetime
from itertools import groupby

from hoga.api.screener_bar_volume import VolumeBar
from hoga.live.volume_state import MINUTE
from hoga.util.timeenc import KST

TIMEFRAMES = {'1m', '3m', '5m', '10m'}


def candle_count(leaf):
    return leaf.params.period + getattr(leaf.params, 'lookback', 1) - 1


def minute_count(leaf):
    minutes = int(leaf.params.timeframe[:-1])
    count = candle_count(leaf)
    # Retain an extra bucket: the oldest retained raw minute can cut a bucket
    # prefix, and the latest bucket can still be open.
    return count if minutes == 1 else (count + 1) * minutes - 1


def requirement(leaves):
    return max(minute_count(leaf) for leaf in leaves)


def session_start(stamp):
    clock = datetime.fromtimestamp(stamp / 1000, KST)
    return int(clock.replace(hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000)


def aggregate(history, leaf, now):
    """REST attests quiet minutes; source continuity/repair guards WS omissions.

    Do not invent empty candles. Like vendor candles, a bucket is emitted only
    if it contains an observed minute. A retained, cut prefix is never complete.
    """
    interval = int(leaf.params.timeframe[:-1]) * MINUTE
    data = history.bars
    if interval == MINUTE or not data:
        return list(data), set(history.lower)
    result, lower = [], set()
    opening = session_start(data[-1].start_ms)
    closing = opening + 390 * MINUTE
    for start, items in groupby(data, key=lambda b: opening + (b.start_ms - opening) // interval * interval):
        minutes = list(items)
        is_open = now < min(start + interval, closing)
        valid = start >= history.coverage_start_ms and all(b.valid for b in minutes)
        bounded = any(b.start_ms in history.lower for b in minutes)
        result.append(VolumeBar(start, sum(b.volume for b in minutes), is_open,
                                valid and (is_open or not bounded)))
        if bounded:
            lower.add(start)
    return result, lower


def window(history, leaf, now):
    data, lower = aggregate(history, leaf, now)
    return data[-(candle_count(leaf) + 1):], lower


def prepared(history, leaves, now):
    return bool(history.fetched_ms) and all(len(window(history, leaf, now)[0]) >= candle_count(leaf)
                                           for leaf in leaves)


def trim(history):
    data = history.bars[-(history.needed + 1):]
    if len(data) < len(history.bars):
        history.coverage_start_ms = max(history.coverage_start_ms, data[0].start_ms)
    history.bars = data


def close_minutes(bars, lower, now):
    # A quiet/disconnected stream must still close its last observed minute so
    # a partial baseline becomes repair work, rather than an eternal open bar.
    return [replace(bar, is_open=False, valid=bar.valid and bar.start_ms not in lower)
            if bar.is_open and bar.start_ms + MINUTE <= now else bar for bar in bars]


def reset_day(history, stamp):
    """Never let yesterday's comparisons or replay evidence enter today's scan."""
    opening = session_start(stamp)
    if history.bars and session_start(history.bars[-1].start_ms) < opening:
        history.bars.clear()
        history.lower.clear()
        history.observed.clear()
        history.canonical.clear()
        history.fetched_ms = history.source_seen_ms = history.repair_until_ms = 0
        history.source_epoch = history.generation = ''
        history.reason = None
        history.retry_at = 0
        history.coverage_start_ms = opening
    return opening


def source_bars(history, state):
    if state['bars']:
        reset_day(history, state['bars'][-1][0])
    opening = session_start(history.bars[-1].start_ms) if history.bars else 0
    return [bar for bar in state['bars'] if bar[0] >= opening]
