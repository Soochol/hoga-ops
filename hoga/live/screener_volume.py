"""Bounded, in-memory volume watches fed by the parent LiveBuffer.

No REST, dataframe work or disk I/O on the tick path. REST seeds comparison
bars; cumulative trade deltas advance the open bar. A seed taken mid-bar is a
lower bound (trades during the REST request may be missing), never an inflated
volume. Such a bar must be reconciled before becoming a comparison bar.
"""
from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime

from hoga.util.timeenc import KST

MINUTE_MS = 60_000
FRESH_MS = 15_000
WATCH_TTL_MS = 300_000
MAX_WATCHES = 512
MAX_BARS = 250_000
NOTIFY_DELAY_S = 0.1


@dataclass
class _Watch:
    bars: list
    period: int
    count: int
    ids: set[str]
    seeded_ms: int
    touched_ms: int
    received_ms: int = 0
    cum: int | None = None
    threshold: int | None = None
    matched: bool = False
    lower_bounds: set[int] = field(default_factory=set)

    def reset_threshold(self):
        previous = self.bars[-self.period:-1]
        self.threshold = (max((b.volume for b in previous), default=0)
                          if len(previous) == self.period - 1 and all(b.valid for b in previous) else None)
        self.matched = self.matches()

    def matches(self):
        return bool(self.bars and self.bars[-1].valid and self.threshold is not None
                    and self.bars[-1].volume > 0 and self.bars[-1].volume >= self.threshold)


class ScreenerVolumeRuntime:
    def __init__(self, publish=None):
        self._publish = publish
        self._watches: OrderedDict[tuple, _Watch] = OrderedDict()
        self._by_code: dict[str, set[tuple]] = {}
        self._last: dict[str, tuple[int, int | None]] = {}
        self._pending: set[str] = set()
        self._timer: asyncio.TimerHandle | None = None

    @staticmethod
    def supports(leaf):
        return (leaf.type in {"new_high_vol", "new_high_vol_today"}
                and leaf.params.timeframe.endswith("m")
                and not hasattr(leaf.params, "mode") and leaf.params.include_open_bar)

    @staticmethod
    def _key(leaf, code):
        p = leaf.params
        return code, p.timeframe, p.period, getattr(p, "lookback", 1)

    def seed(self, leaf, code, snapshot, now_ms):
        if not self.supports(leaf) or snapshot.reason or not snapshot.bars:
            return
        p = leaf.params
        count = p.period + getattr(p, "lookback", 1) - 1
        data = snapshot.bars[-(count + 1):]
        # An old response must not replace a more recent WS overlay when a
        # coalesced cached REST snapshot is reused by a second tab.
        key = self._key(leaf, code)
        old = self._watches.get(key)
        if old and old.seeded_ms >= snapshot.fetched_at_ms:
            old.ids.add(leaf.id)
            old.touched_ms = now_ms
            return
        lower_bounds = set()
        if old:
            # A delayed REST response must not erase a crossing already observed
            # on WS while that request was in flight. Merge by bar, never add two
            # cumulative snapshots of the same volume.
            latest = old.bars[-1]
            if latest.start_ms == data[-1].start_ms:
                data[-1] = replace(data[-1], volume=max(data[-1].volume, latest.volume))
            elif latest.start_ms > data[-1].start_ms:
                data = (data + [b for b in old.bars if b.start_ms > data[-1].start_ms])[-(count + 1):]
                lower_bounds.update(old.lower_bounds)
        last = self._last.get(code)
        self._remove(key)
        ids = old.ids | {leaf.id} if old else {leaf.id}
        watch = _Watch(list(data), p.period, count, ids, snapshot.fetched_at_ms, now_ms)
        watch.lower_bounds = lower_bounds
        if data[-1].is_open:
            watch.lower_bounds.add(data[-1].start_ms)
        if last and now_ms - last[0] <= FRESH_MS:
            watch.received_ms, watch.cum = last
            self._last[code] = last
        watch.reset_threshold()
        self._watches[key] = watch
        self._by_code.setdefault(code, set()).add(key)
        while len(self._watches) > MAX_WATCHES or sum(len(w.bars) for w in self._watches.values()) > MAX_BARS:
            self._remove(next(iter(self._watches)))

    def snapshot(self, leaf, code, now_ms):
        if not self.supports(leaf):
            return None
        key = self._key(leaf, code)
        watch = self._watches.get(key)
        if watch is None or now_ms - watch.touched_ms > WATCH_TTL_MS:
            self._remove(key)
            return None
        watch.touched_ms = now_ms
        watch.ids.add(leaf.id)
        # Keep REST reconciliation periodic even on a busy WS stream.
        if now_ms - watch.received_ms > FRESH_MS or now_ms - watch.seeded_ms > FRESH_MS:
            return None
        self._watches.move_to_end(key)
        return list(watch.bars), watch.received_ms, set(watch.lower_bounds)

    def counts(self, leaves, codes, now_ms):
        selected = [leaf for leaf in leaves if self.supports(leaf)]
        prepared = receiving = 0
        for code in codes:
            watches = [self._watches.get(self._key(leaf, code)) for leaf in selected]
            if watches and all(w and now_ms - w.touched_ms <= WATCH_TTL_MS for w in watches):
                prepared += 1
                if all(now_ms - w.received_ms <= FRESH_MS for w in watches):
                    receiving += 1
        return prepared, receiving

    def ingest(self, code, entry, now_ms):
        if code not in self._by_code:
            return
        if entry.get("kind") != "trade" or entry.get("venue", "KRX") != "KRX":
            return
        stamp = entry.get("t_ms", 0)
        clock = datetime.fromtimestamp(stamp / 1000, KST)
        if (clock.hour, clock.minute) < (9, 0) or (clock.hour, clock.minute) > (15, 30):
            return
        if now_ms - stamp > FRESH_MS or stamp > now_ms + 1000:
            return
        cum = entry.get("cum_volume")
        if type(cum) is not int or cum <= 0:
            return  # Never invent an exact volume from coalesced/dropped trades.
        prior = self._last.get(code)
        if prior and (stamp < prior[0] or cum == prior[1]):
            return
        if prior and (cum < prior[1] or stamp - prior[0] > FRESH_MS):
            self.gap({code})
            prior = None
        # Bounded by the watched code set; unknown full-market ticks cost O(1).
        self._last[code] = (stamp, cum)
        for key in list(self._by_code[code]):
            watch = self._watches[key]
            if now_ms - watch.touched_ms > WATCH_TTL_MS:
                self._remove(key)
                continue
            self._advance(key, watch, entry, stamp, cum, prior, clock)

    def _advance(self, key, watch, entry, stamp, cum, prior, clock):
        interval = int(key[1][:-1]) * MINUTE_MS
        day_start = int(clock.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
        start = day_start + 9 * 60 * MINUTE_MS
        bucket = start + (stamp - start) // interval * interval
        latest = watch.bars[-1]
        open_bar = (clock.hour, clock.minute) < (15, 30)
        if bucket < latest.start_ms:
            return
        if bucket > latest.start_ms:
            trades = entry.get("trades", [])
            qty = sum(t.get("qty", 0) for t in trades if t.get("t_ms", stamp) >= bucket)
            continuous = (prior is not None and cum - prior[1] == qty
                          and bucket - latest.start_ms == interval)
            # A lower-bound finished bar cannot become an understated peak.
            # A cumulative jump across a boundary cannot be assigned to either
            # minute, so both need REST reconciliation (including fast reconnects).
            watch.bars[-1] = replace(latest, is_open=False,
                valid=latest.valid and latest.start_ms not in watch.lower_bounds and continuous)
            watch.bars.append(replace(latest, start_ms=bucket, volume=max(0, qty), is_open=open_bar, valid=True))
            watch.bars = watch.bars[-(watch.count + 1):]
            watch.lower_bounds.intersection_update(b.start_ms for b in watch.bars)
            # A skipped interval is not proof of a complete first trade.
            if not continuous:
                watch.lower_bounds.add(bucket)
            watch.reset_threshold()
            self._notify(watch.ids)  # recency window moved, including removals
        elif watch.cum is not None and cum > watch.cum:
            watch.bars[-1] = replace(latest, volume=latest.volume + cum - watch.cum, is_open=open_bar)
        elif watch.cum is None:
            qty = sum(t.get("qty", 0) for t in entry.get("trades", []))
            watch.bars[-1] = replace(latest, volume=max(latest.volume, qty), is_open=open_bar)
        if latest.is_open and not open_bar:
            self._notify(watch.ids)
        watch.cum, watch.received_ms = cum, stamp
        matched = watch.matches()
        if matched != watch.matched:
            watch.matched = matched
            self._notify(watch.ids)

    def gap(self, codes):
        for code in codes:
            self._last.pop(code, None)
            for key in list(self._by_code.get(code, ())):
                watch = self._watches[key]
                watch.cum = None
                watch.received_ms = 0
                watch.lower_bounds.add(watch.bars[-1].start_ms)
                self._notify(watch.ids)

    def _notify(self, ids):
        self._pending.update(ids)
        if self._publish is not None and self._timer is None:
            self._timer = asyncio.get_running_loop().call_later(NOTIFY_DELAY_S, self._flush)

    def _flush(self):
        self._timer = None
        ids, self._pending = sorted(self._pending), set()
        if ids and self._publish:
            self._publish({"type": "screener_volume_changed", "condition_ids": ids})

    def _remove(self, key):
        if self._watches.pop(key, None) is None:
            return
        keys = self._by_code[key[0]]
        keys.discard(key)
        if not keys:
            del self._by_code[key[0]]
            self._last.pop(key[0], None)

    def close(self):
        if self._timer:
            self._timer.cancel()
        self._timer = None
        self._pending.clear()
        self._watches.clear()
        self._by_code.clear()
        self._last.clear()
