"""Bounded absolute KRX minute states, independent of lossy display delivery.

This is a memory-only consumer of already received raw trades. No vendor calls,
files, dataframes, broker subscriptions or awaited work on the ingest path.
"""
from __future__ import annotations

import math
import re
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime

from hoga.api.params import CODE_PATTERN
from hoga.util.timeenc import KST

from .collector_ipc import DISPLAY_MAX_FRAME_BYTES, encode

MINUTE = 60_000
REPLAY_MS = 15 * MINUTE
MAX_STREAMS = 512
MAX_REPLAY_BARS = 16
FRESH_MS = 5000
PROTOCOL = 2
MAX_INTEGER = 2**63 - 1
MAX_GENERATION_LENGTH = 256
MAX_CHUNK_STREAMS = 64
BAR_FIELDS = 10
_STOCK_CODE = re.compile(CODE_PATTERN)


@dataclass(slots=True)
class MinuteState:
    start: int
    volume: int
    valid: bool
    open: float | None = None
    high: float | None = None
    low: float | None = None
    close: float | None = None
    prices_complete: bool = False
    first_tick_ms: int = 0
    last_tick_ms: int = 0

    def invalidate(self):
        self.valid = self.prices_complete = False

    def row(self):
        return [self.start, self.volume, self.valid, self.open, self.high, self.low, self.close,
                self.prices_complete, self.first_tick_ms, self.last_tick_ms]


def _price(value):
    return type(value) in (int, float) and 0 < value <= MAX_INTEGER and math.isfinite(value)


def _trade_prices(trades, stamp):
    bucket = stamp // MINUTE * MINUTE
    prices, ticks, complete = [], [], True
    for trade in trades:
        if not isinstance(trade, dict):
            complete = False
            continue
        tick = trade.get('t_ms')
        if (type(tick) is not int or not bucket <= tick <= stamp
                or type(trade.get('qty')) is not int or not 0 < trade['qty'] <= MAX_INTEGER
                or (ticks and tick < ticks[-1]) or not _price(trade.get('price'))):
            complete = False
            continue
        prices.append(trade['price'])
        ticks.append(tick)
    return prices, ticks, complete and bool(prices)


@dataclass(slots=True)
class StreamState:
    bars: list[MinuteState] = field(default_factory=list)
    generation: str = ''
    connection: str = ''
    incarnation: int = 0
    healthy_since: int = 0
    ready: bool = False
    revision: int = 0
    last_cum: int | None = None
    last_tick: int = 0
    day: str = ''


class VolumeSource:
    def __init__(self, epoch: str):
        self.epoch = epoch
        self.serial = 0
        self.streams: dict[str, StreamState] = {}

    def configure(self, codes):
        codes = set(codes)
        if len(codes) > MAX_STREAMS:
            raise ValueError('volume stream capacity exceeded')
        streams = {}
        for code in sorted(codes):
            if code in self.streams:
                streams[code] = self.streams[code]
            else:
                self.serial += 1
                streams[code] = StreamState(incarnation=self.serial, generation=f'{self.serial}:offline')
        self.streams = streams

    def health(self, generations: dict[str, str], now: int):
        for code, stream in self.streams.items():
            generation = generations.get(code, '')
            if generation != stream.connection:
                if stream.bars:
                    stream.bars[-1].invalidate()
                stream.connection = generation
                stream.generation = f'{stream.incarnation}:{generation or "offline"}'
                stream.healthy_since = now
                stream.last_cum = None
                stream.revision += 1
            stream.ready = bool(generation)

    def ingest(self, code: str, entry: dict, now: int):
        stream = self.streams.get(code)
        if stream is None or entry.get('kind') != 'trade' or entry.get('venue', 'KRX') != 'KRX':
            return
        stamp, cum = entry.get('t_ms', 0), entry.get('cum_volume')
        if type(stamp) is not int or now - stamp > FRESH_MS or stamp > now + 1000:
            if stream.bars:
                stream.bars[-1].invalidate()
            stream.healthy_since = now
            stream.revision += 1
            return
        clock = datetime.fromtimestamp(stamp / 1000, KST)
        if not (900 <= clock.hour * 100 + clock.minute <= 1530):  # noqa: PLR2004 — regular KRX session
            return
        self._ingest_trade(stream, entry, now, stamp, cum, clock)

    def _ingest_trade(self, stream, entry, now, stamp, cum, clock):
        trades = entry.get('trades')
        qty = (sum(t['qty'] for t in trades if isinstance(t, dict) and type(t.get('qty')) is int and t['qty'] > 0)
               if isinstance(trades, (list, tuple)) else 0)
        if not 0 < qty <= MAX_INTEGER or type(cum) is not int or not qty <= cum <= MAX_INTEGER:
            if stream.bars:
                stream.bars[-1].invalidate()
            stream.revision += 1
            return
        day = clock.date().isoformat()
        if day != stream.day:
            stream.day, stream.last_cum = day, None
            stream.healthy_since = max(stream.healthy_since, int(clock.replace(
                hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000))
        if stamp < stream.last_tick or (stream.last_cum is not None and cum < stream.last_cum):
            if stream.bars:
                stream.bars[-1].invalidate()
            stream.last_cum = None
            stream.healthy_since = now
            stream.revision += 1
            return
        if cum == stream.last_cum:
            return
        bucket = stamp // MINUTE * MINUTE
        delta = cum - stream.last_cum if stream.last_cum is not None else None
        prices, ticks, prices_valid = _trade_prices(trades, stamp)
        continuous_prices = delta == qty or (delta is None and bucket == int(clock.replace(
            hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000) and cum == qty)
        if not stream.bars or stream.bars[-1].start != bucket:
            continuous = delta is None or delta == qty
            if stream.bars and not continuous:
                stream.bars[-1].invalidate()
            stream.bars.append(MinuteState(bucket, qty, bool(
                continuous and stream.ready and stream.healthy_since <= bucket),
                prices_complete=bool(continuous_prices and prices_valid and stream.ready
                                     and stream.healthy_since <= bucket),
                first_tick_ms=ticks[0] if ticks else stamp, last_tick_ms=stamp))
        else:
            bar = stream.bars[-1]
            bar.volume += delta if delta is not None else qty
            bar.prices_complete &= (continuous_prices and prices_valid
                                    and bool(ticks and ticks[0] >= bar.last_tick_ms))
            if delta is None:
                bar.valid = False
        bar = stream.bars[-1]
        if prices:
            bar.open = bar.open if bar.open is not None else prices[0]
            bar.high = max([*prices, *([bar.high] if bar.high is not None else [])])
            bar.low = min([*prices, *([bar.low] if bar.low is not None else [])])
            bar.close = prices[-1]
        bar.last_tick_ms = max(bar.last_tick_ms, ticks[-1] if ticks else stamp)
        stream.bars = [b for b in stream.bars if b.start >= bucket - REPLAY_MS][-MAX_REPLAY_BARS:]
        stream.last_cum, stream.last_tick = cum, stamp
        stream.revision += 1

    def frames(self, now: int):
        """Full per-stream replay; encode once per chunk, not once per tick/code."""
        chunks, chunk = [], {}
        for code, stream in self.streams.items():
            chunk[code] = {'revision': stream.revision, 'generation': stream.generation,
                'ready': stream.ready, 'tick_ms': stream.last_tick,
                'since_ms': stream.healthy_since, 'replay_since_ms': now - REPLAY_MS,
                'bars': [b.row() for b in stream.bars]}
            if len(chunk) == MAX_CHUNK_STREAMS:
                chunks.extend(self._frames(chunk, now))
                chunk = {}
        if chunk:
            chunks.extend(self._frames(chunk, now))
        return chunks

    def _frames(self, streams, now):
        frame = {'protocol': PROTOCOL, 'epoch': self.epoch, 'observed_ms': now, 'streams': streams}
        if len(encode(frame)) <= DISPLAY_MAX_FRAME_BYTES:
            return [frame]
        if len(streams) == 1:
            raise ValueError('single volume stream exceeds frame budget')
        entries = list(streams.items())
        middle = len(entries) // 2
        return self._frames(dict(entries[:middle]), now) + self._frames(dict(entries[middle:]), now)


def _uint(value):
    return type(value) is int and 0 <= value <= MAX_INTEGER


def _validated_state(code, state, observed):
    if (not isinstance(code, str) or _STOCK_CODE.fullmatch(code) is None or not isinstance(state, dict)
            or not _uint(state['revision']) or not isinstance(state['generation'], str)
            or not 0 < len(state['generation']) <= MAX_GENERATION_LENGTH or type(state['ready']) is not bool
            or not _uint(state['tick_ms']) or not _uint(state['since_ms'])
            or max(state['tick_ms'], state['since_ms']) > observed + 1000
            or not isinstance(state['bars'], (list, tuple)) or len(state['bars']) > MAX_REPLAY_BARS):
        raise ValueError('invalid volume state')
    replay_since = state['replay_since_ms']
    if not _uint(replay_since) or not observed - REPLAY_MS <= replay_since <= observed:
        raise ValueError('invalid volume coverage bound')
    previous_start, day, bars = 0, None, []
    for row in state['bars']:
        if not isinstance(row, (list, tuple)) or len(row) != BAR_FIELDS:
            raise ValueError('invalid volume bar')
        start, volume, valid, o, h, low, c, complete, first, last = row
        if (not _uint(start) or start % MINUTE or start <= previous_start or not _uint(volume)
                or type(valid) is not bool or type(complete) is not bool
                or not _uint(first) or not _uint(last) or not start <= first <= last < start + MINUTE
                or last > state['tick_ms'] or last > observed + 1000):
            raise ValueError('invalid volume bar')
        clock = datetime.fromtimestamp(start / 1000, KST)
        if (not 900 <= clock.hour * 100 + clock.minute <= 1530  # noqa: PLR2004 — regular KRX session
                or (day is not None and clock.date() != day)):
            raise ValueError('invalid volume bar day')
        prices = (o, h, low, c)
        if not (all(value is None for value in prices) or
                (all(_price(value) for value in prices) and low <= min(o, c) <= max(o, c) <= h)):
            raise ValueError('invalid volume prices')
        if complete and (not valid or o is None):
            raise ValueError('invalid complete volume prices')
        bars.append(list(row))
        previous_start, day = start, clock.date()
    return {name: state[name] for name in ('revision', 'generation', 'ready', 'tick_ms', 'since_ms')} | {
        'bars': bars, 'observed_ms': observed, 'replay_since_ms': replay_since}


class VolumeReplica:
    def __init__(self):
        self.epoch = ''
        self.streams: OrderedDict[str, dict] = OrderedDict()

    def reset(self, epoch):
        self.epoch = epoch
        self.serial = 0
        self.streams.clear()

    def apply(self, frame: dict, now: int | None = None):
        now = int(time.time() * 1000) if now is None else now
        if not isinstance(frame, dict) or frame.get('protocol') != PROTOCOL or frame.get('epoch') != self.epoch:
            raise ValueError('volume protocol/epoch mismatch')
        try:
            observed, streams = frame['observed_ms'], frame['streams']
            if not _uint(observed):
                raise ValueError('invalid volume observation')
            if abs(now - observed) > FRESH_MS:
                return
            if (not isinstance(streams, dict) or len(streams) > MAX_CHUNK_STREAMS
                    or len(encode(frame)) > DISPLAY_MAX_FRAME_BYTES):
                raise ValueError('invalid volume chunk')
            updates = {code: _validated_state(code, state, observed) for code, state in streams.items()}
        except (KeyError, TypeError, OverflowError) as exc:
            raise ValueError('invalid volume state') from exc
        for code, state in updates.items():
            old = self.streams.get(code)
            if old and old['generation'] == state['generation'] and old['revision'] > state['revision']:
                continue
            if old and old['observed_ms'] > observed:
                continue
            self.streams[code] = state
            self.streams.move_to_end(code)
            while len(self.streams) > MAX_STREAMS:
                self.streams.popitem(last=False)

    def get(self, code, now):
        state = self.streams.get(code)
        return state if state and now - state['observed_ms'] <= FRESH_MS else None


def manager_generations(manager, now):
    """Connection evidence, not a quiet symbol's last trade, defines readiness."""
    result = {}
    connections = getattr(manager, '_conns', {})
    for account, connection in connections.items():
        client = connection.client
        if (not client.connected or not getattr(client, 'registration_ready', False)
                or now - (client.last_recv_ms or 0) > 120_000):  # noqa: PLR2004 — transport liveness guard
            continue
        registered = client.expected_codes - set(client.sub_missing())
        for code in connection.codes:
            if code in registered:
                result[code] = f'{account}:{client.connection_generation}'
    return result
