from dataclasses import replace
from datetime import datetime
from itertools import groupby

from hoga.api.screener_bar_policy import CHANGE_TYPES, comparison_period, lookback
from hoga.api.screener_bar_price import valid_prices
from hoga.api.screener_bar_volume import VolumeBar
from hoga.live.volume_state import MINUTE
from hoga.util.timeenc import KST

TIMEFRAMES = {'1m', '3m', '5m', '10m'}


def ordered_minute_bar(old, incoming):
    newer, older = (incoming, old) if incoming.volume > old.volume else (old, incoming)
    same = all(getattr(old, name) == getattr(incoming, name) for name in ('open', 'high', 'low', 'close'))
    coherent = (newer.open == older.open and newer.high >= older.high and newer.low <= older.low)
    if (old.volume == incoming.volume and not same) or not coherent:
        return replace(newer, valid=False, open=None, high=None, low=None, close=None)
    return newer


def reconcile_source(history, old, incoming, last, now):
    selected = ordered_minute_bar(old, incoming)
    if not selected.valid:
        history.repair_until_ms = max(history.repair_until_ms, now)
    else:
        if selected is incoming:
            history.observation_ms[incoming.start_ms] = last
        if incoming.volume >= old.volume:
            history.lower.discard(incoming.start_ms)
    return selected


def reconcile_rest(history, incoming, response_received):
    observations = {stamp: response_received for stamp in incoming}
    conflict = False
    for bar in history.bars:
        rest = incoming.get(bar.start_ms)
        if rest is None:
            incoming[bar.start_ms] = bar
            observations[bar.start_ms] = history.observation_ms.get(bar.start_ms, history.fetched_ms)
        elif bar.is_open and rest.is_open:
            if bar.valid and valid_prices(bar) and rest.valid and valid_prices(rest):
                selected = ordered_minute_bar(bar, rest)
            elif bar.volume > rest.volume:
                selected = bar
            else:
                selected = rest
            incoming[bar.start_ms] = selected
            conflict |= not selected.valid
            if selected is bar:
                observations[bar.start_ms] = history.observation_ms.get(bar.start_ms, history.fetched_ms)
    history.bars = sorted(incoming.values(), key=lambda b: b.start_ms)
    trim(history)
    retained = {bar.start_ms for bar in history.bars}
    history.observation_ms = {k: v for k, v in observations.items() if k in retained}
    return conflict


def candle_count(leaf):
    return comparison_period(leaf) + lookback(leaf) - 1


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
        prices = {}
        if start >= history.coverage_start_ms and all(valid_prices(bar) for bar in minutes):
            prices = dict(open=minutes[0].open, high=max(bar.high for bar in minutes),
                          low=min(bar.low for bar in minutes), close=minutes[-1].close)
        result.append(VolumeBar(start, sum(b.volume for b in minutes), is_open,
                                valid and (is_open or not bounded), **prices))
        if bounded:
            lower.add(start)
    return result, lower


def window(history, leaf, now):
    data, lower = aggregate(history, leaf, now)
    return data[-(candle_count(leaf) + 1):], lower


def prepared(history, leaves, now):
    if not history.fetched_ms:
        return False
    for leaf in leaves:
        data = window(history, leaf, now)[0]
        count = candle_count(leaf)
        if len(data) < count or (leaf.type in CHANGE_TYPES and not all(valid_prices(bar) for bar in data[-count:])):
            return False
    return True


def damaged(history, leaves, now):
    return bool(history.repair_until_ms) or any(
        not bar.valid or leaf.type in CHANGE_TYPES and not valid_prices(bar)
        for leaf in leaves for bar in window(history, leaf, now)[0][-candle_count(leaf):])


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
        history.observation_ms.clear()
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
