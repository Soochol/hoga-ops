"""Bounded absolute KRX minute states, independent of lossy display delivery.

This is a memory-only consumer of already received raw trades. No vendor calls,
files, dataframes, broker subscriptions or awaited work on the ingest path.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import datetime

from hoga.util.timeenc import KST

from .collector_ipc import DISPLAY_MAX_FRAME_BYTES, encode

MINUTE = 60_000
REPLAY_MS = 15 * MINUTE
MAX_STREAMS = 512
MAX_REPLAY_BARS = 16
FRESH_MS = 5000
PROTOCOL = 1


@dataclass(slots=True)
class MinuteState:
    start: int
    volume: int
    valid: bool


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
                    stream.bars[-1].valid = False
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
                stream.bars[-1].valid = False
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
        if not qty or type(cum) is not int or cum <= 0:
            if stream.bars:
                stream.bars[-1].valid = False
            return
        day = clock.date().isoformat()
        if day != stream.day:
            stream.day, stream.last_cum = day, None
            stream.healthy_since = max(stream.healthy_since, int(clock.replace(
                hour=9, minute=0, second=0, microsecond=0).timestamp() * 1000))
        if stamp < stream.last_tick or (stream.last_cum is not None and cum < stream.last_cum):
            if stream.bars:
                stream.bars[-1].valid = False
            stream.last_cum = None
            stream.healthy_since = now
            stream.revision += 1
            return
        if cum == stream.last_cum:
            return
        bucket = stamp // MINUTE * MINUTE
        delta = cum - stream.last_cum if stream.last_cum is not None else None
        if not stream.bars or stream.bars[-1].start != bucket:
            continuous = delta is None or delta == qty
            if stream.bars and not continuous:
                stream.bars[-1].valid = False
            stream.bars.append(MinuteState(bucket, qty, bool(
                continuous and stream.ready and stream.healthy_since <= bucket)))
        else:
            bar = stream.bars[-1]
            bar.volume += delta if delta is not None else qty
            if delta is None:
                bar.valid = False
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
                'bars': [[b.start, b.volume, b.valid] for b in stream.bars]}
            if len(chunk) == 64:  # noqa: PLR2004 — independent IPC chunk budget
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
        if frame.get('protocol') != PROTOCOL or frame.get('epoch') != self.epoch:
            raise ValueError('volume protocol/epoch mismatch')
        observed = frame['observed_ms']
        if type(observed) is not int or abs(now - observed) > FRESH_MS:
            return
        streams = frame['streams']
        if not isinstance(streams, dict) or len(streams) > 64:  # noqa: PLR2004 — IPC chunk budget
            raise ValueError('invalid volume chunk')
        for code, state in streams.items():
            if (len(code) != 6 or not code.isdigit() or type(state['revision']) is not int  # noqa: PLR2004
                    or not isinstance(state['generation'], str) or type(state['ready']) is not bool
                    or type(state['tick_ms']) is not int or type(state['since_ms']) is not int
                    or len(state['bars']) > MAX_REPLAY_BARS):
                raise ValueError('invalid volume state')
            replay_since = state.get('replay_since_ms', observed - REPLAY_MS)
            if type(replay_since) is not int or replay_since > observed:
                raise ValueError('invalid volume coverage bound')
            previous_start = 0
            for start, volume, valid in state['bars']:
                if (type(start) is not int or start % MINUTE or start <= previous_start
                        or type(volume) is not int or volume < 0 or type(valid) is not bool):
                    raise ValueError('invalid volume bar')
                previous_start = start
            old = self.streams.get(code)
            if old and old['generation'] == state['generation'] and old['revision'] > state['revision']:
                continue
            if old and old['observed_ms'] > observed:
                continue
            self.streams[code] = {**state, 'observed_ms': observed, 'replay_since_ms': replay_since}
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
