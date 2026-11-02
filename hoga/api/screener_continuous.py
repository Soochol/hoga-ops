from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field, replace
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hoga.api import (
    screener_bar_volume as volume,
    screener_continuous_bars as candles,
    screener_expression,
    screener_minute_scope,
    screener_universe,
    symbols,
)
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.api.screener_bar_policy import CHANGE_TYPES, RANGE_PARAMS
from hoga.api.screener_bar_price import valid_prices
from hoga.api.screener_timing import monitor_scan
from hoga.live.volume_state import MAX_REPLAY_BARS, MINUTE, VolumeReplica
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
MAX_MONITORS = 32
MAX_STREAMS = 512
MAX_BARS = 250_000
MAX_BYTES = 64 * 1024 * 1024
BAR_RESERVATION_BYTES = 512  # Conservative admission includes objects, indexes and evidence.
REPLAY_RESERVATION_BYTES = MAX_REPLAY_BARS * 1024
LEASE_MS = 300_000
AUDIT_MS = 300_000
TARGET_REFRESH_MS = 1000
SCOPE_REFRESH_MS = 30_000
CANONICAL_SETTLE_MS = 15_000
MAX_EVALUATIONS = 4096
MAX_CACHED_EVENTS = 16_000


class ContinuousStartRequest(BaseModel):
    client_id: str = Field(min_length=1, max_length=100)
    request: ScanRequest


class ContinuousStatus(BaseModel):
    id: str
    total: int
    prepared: int
    receiving: int
    preparing: int
    recovering: int
    unavailable: int
    insufficient: int
    last_verified_ms: int | None = None
    error: str | None = None


@dataclass
class History:
    needed: int
    bars: list = field(default_factory=list)
    fetched_ms: int = 0
    touched_ms: int = 0
    source_epoch: str = ''
    generation: str = ''
    lower: set[int] = field(default_factory=set)
    observed: dict[int, tuple] = field(default_factory=dict)
    reason: str | None = None
    retry_at: int = 0
    failures: int = 0
    baseline_after_ms: int = 0
    canonical: dict[int, int] = field(default_factory=dict)
    source_seen_ms: int = 0
    repair_until_ms: int = 0
    coverage_start_ms: int = 0
    attempt_day: str = ''
    revision: int = 0
    merge_token: tuple | None = None
    identity: object = field(default_factory=object, repr=False, compare=False)


@dataclass(frozen=True)
class PreparedSnapshot:
    bars: tuple
    lower: frozenset[int]
    coverage_start_ms: int
    fetched_ms: int
    observed_ms: int
    version: tuple | None
    current_day: bool
    reason: str | None
    cutoff_ms: int
    live_ready: bool
    repair_until_ms: int


@dataclass
class ResultFlight:
    task: asyncio.Task[ScreenerResponse]
    waiters: int = 0
    finished: asyncio.Event = field(default_factory=asyncio.Event)


@dataclass
class Monitor:
    id: str
    client_id: str
    request: ScanRequest
    codes: list[str]
    leaves: list
    touched_ms: int
    fingerprint: tuple = ()
    result_flight: ResultFlight | None = field(default=None, repr=False, compare=False)


class ContinuousAdapter:
    def __init__(self, owner, monitor):
        self.owner, self.monitor = owner, monitor
        self.coverage_monitor = monitor
        self._snapshots: dict[str, PreparedSnapshot] = {}

    @staticmethod
    def eligible(leaf):
        family = (leaf.type in {'new_high_vol', 'new_high_vol_today'} or
                  leaf.type in CHANGE_TYPES and leaf.params.change_reference in {'previous_bar', 'bar_open'})
        return (family and leaf.params.timeframe in candles.TIMEFRAMES
                and not isinstance(leaf.params, RANGE_PARAMS) and leaf.params.include_open_bar)

    def supports(self, leaf):
        now = self.owner.now()
        return self.eligible(leaf) and (leaf.type not in CHANGE_TYPES or
            self.owner.selected_day(now) == datetime.fromtimestamp(now / 1000, KST).date())

    def snapshot(self, leaf, code, now):
        snapshot = self.owner.snapshot(code, now)
        data, lower = candles.window(snapshot, leaf, now)
        return data, snapshot.observed_ms, lower

    async def evaluate_leaf(self, leaf, code, now):
        if code not in self._snapshots:
            self._snapshots[code] = self.owner.snapshot(code, now)
        snapshot = self._snapshots[code]
        version = snapshot.version
        key = code, leaf.model_dump_json()
        cached = self.owner.evaluations.get(key)
        if cached is not None and cached[0] == version:
            self.owner.evaluations.move_to_end(key)
        else:
            flight = key, version
            task = self.owner.evaluation_flights.get(flight)
            if task is None:
                task = asyncio.create_task(self._evaluate_changed(leaf, code, now, key, snapshot))
                self.owner.evaluation_flights[flight] = task
                task.add_done_callback(lambda _task: self.owner.evaluation_flights.pop(flight, None))
            cached = await asyncio.shield(task)
        return leaf, code, [event.model_copy(deep=True) for event in cached[1]], cached[2], cached[3]

    async def _evaluate_changed(self, leaf, code, now, key, snapshot):
        now = snapshot.cutoff_ms
        version = snapshot.version
        cached = self.owner.evaluations.get(key)
        if cached is None or cached[0] != version:
            data, lower = candles.window(snapshot, leaf, now)
            events, complete = await asyncio.to_thread(volume.records, leaf, data, fetched_at_ms=snapshot.observed_ms)
            for event in events:
                if event.bar_match and event.bar_start_ms in lower:
                    event.bar_match.volume_is_lower_bound = True
            reason = self._reason(snapshot, [leaf], now)
            if not reason and not complete and lower and any(not bar.valid for bar in data):
                reason = 'live_bar_unconfirmed'
            cached = version, events, complete and reason is None, reason
            history = self.owner.histories.get(code)
            if self.owner.closed or (history and self.owner.version(code, history, self.owner.now()) != version):
                return cached
            old = self.owner.evaluations.pop(key, None)
            self.owner._event_count -= len(old[1]) if old else 0
            self.owner.evaluations[key] = cached
            self.owner._event_count += len(events)
            while len(self.owner.evaluations) > MAX_EVALUATIONS or self.owner._event_count > MAX_CACHED_EVENTS:
                _, old = self.owner.evaluations.popitem(last=False)
                self.owner._event_count -= len(old[1])
        elif key in self.owner.evaluations:
            self.owner.evaluations.move_to_end(key)
        return cached

    def seed(self, *args):
        pass  # Preparation belongs exclusively to the background coordinator.

    def counts(self, leaves, codes, now):
        self.coverage_monitor = replace(self.monitor, codes=list(codes))
        for code in codes:
            if code not in self._snapshots:
                self._snapshots[code] = self.owner.snapshot(code, now)
        status = self.owner.status(self.coverage_monitor, now, snapshots=self._snapshots)
        return status.prepared, status.receiving

    def reason(self, code, leaf=None):
        now = self.owner.now()
        snapshot = self._snapshots.get(code) or self.owner.snapshot(code, now)
        leaves = [leaf] if leaf else self.monitor.leaves
        return self._reason(snapshot, leaves, snapshot.cutoff_ms)

    @staticmethod
    def _reason(snapshot, leaves, now):
        if snapshot.reason and not candles.prepared(snapshot, leaves, now):
            return snapshot.reason
        if not snapshot.fetched_ms or not snapshot.current_day:
            return 'volume_preparing'
        if not candles.prepared(snapshot, leaves, now):
            if any(len(candles.window(snapshot, leaf, now)[0]) < candles.candle_count(leaf) for leaf in leaves):
                return 'insufficient_minute_history'
            return 'live_bar_unconfirmed'
        return None

    def coverage(self):
        now = self.owner.now()
        status = self.owner.status(self.coverage_monitor, now, snapshots=self._snapshots)
        return {**status.model_dump(exclude={'id', 'total', 'error'}), 'monitor_error': status.error,
                'trading_date': self.owner.selected_day(now).isoformat()}


class ContinuousMonitors:
    def __init__(self, data_dir, bus, buffer, set_targets, *, loader=None, now=None):
        self.data_dir, self.bus, self.buffer, self.set_targets = data_dir, bus, buffer, set_targets
        self.replica: VolumeReplica = buffer.volume_replica
        self.loader = loader or volume.monitor_day_snapshot
        self.now = now or (lambda: int(time.time() * 1000))
        self.monitors: dict[str, Monitor] = {}
        self.histories: dict[str, History] = {}
        self.pending: dict[str, asyncio.Task] = {}
        self.loop_task: asyncio.Task | None = None
        self.closed = False
        self._last_targets = 0
        self._last_scope = 0
        self._errors: dict[str, str] = {}
        self._day_cache: tuple | None = None
        self._fingerprints = {}
        self._quality = {}
        self.evaluations = OrderedDict()
        self._event_count = 0
        self.evaluation_flights = {}
        self.result_tasks: set[asyncio.Task[ScreenerResponse]] = set()

    def selected_day(self, now):
        # Calendar I/O is outside raw ingest and shared across all result/status
        # reads for 30 seconds, including the midnight/preopen transition.
        key = now // SCOPE_REFRESH_MS
        if self._day_cache is None or self._day_cache[0] != key:
            clock = datetime.fromtimestamp(now / 1000, KST)
            try:
                day = screener_minute_scope.resolve(self.data_dir, clock).day
            except ValueError:
                day = clock.date()  # Unknown calendar never admits yesterday.
            self._day_cache = key, day
        return self._day_cache[1]

    def current_day(self, history, now):
        return bool(history.bars) and datetime.fromtimestamp(
            history.bars[-1].start_ms / 1000, KST).date() == self.selected_day(now)

    def snapshot(self, code, now):
        history = self.histories.get(code)
        if history is None:
            return PreparedSnapshot((), frozenset(), 0, 0, now, None, False, None, now, False, 0)
        state = self.replica.get(code, now)
        if state:
            now = max(now, state['observed_ms'], state['tick_ms'])
        self.merge(code, history, now)
        state = self.replica.get(code, now)
        current = self.current_day(history, now)
        data = tuple(history.bars) if current else ()
        if history.repair_until_ms or (self.live_clock(now) and (not state or not state['ready'])):
            data = tuple(replace(bar, valid=False) for bar in data)
        return PreparedSnapshot(data, frozenset(history.lower), history.coverage_start_ms,
            history.fetched_ms, max([history.fetched_ms, *(item[3] for item in history.observed.values())]),
            self.version(code, history, now), current, history.reason, now,
            bool(self.live_clock(now) and state and state['ready']), history.repair_until_ms)

    def live_clock(self, now):
        return (self.market_clock(now) and now < candles.session_start(now) + 390 * MINUTE
                and self.selected_day(now) == datetime.fromtimestamp(now / 1000, KST).date())

    async def start(self, client_id, request):
        leaves = [leaf for leaf in screener_expression.active_conditions(request.conditions, request.expression)
                  if ContinuousAdapter.eligible(leaf)]
        if not leaves or not request.universe.scopes or request.basis == 'eod':
            raise HTTPException(422, '1·3·5·10분봉 신고거래량 감시는 관심종목·히트맵 범위를 선택해야 합니다.')
        old = next((m for m in self.monitors.values() if m.client_id == client_id), None)
        if old and old.request == request:
            old.touched_ms = self.now()
            return self.status(old, self.now())
        if len(self.monitors) >= MAX_MONITORS and old is None:
            raise HTTPException(409, '동시 감시 개수 한도를 초과했습니다.')
        codes = await self.resolve(request)
        needed = candles.requirement(leaves)
        requirements = {code: needed for code in codes}
        for monitor in self.monitors.values():
            if monitor is old:
                continue
            count = candles.requirement(monitor.leaves)
            for code in monitor.codes:
                requirements[code] = max(requirements.get(code, 0), count)
        self.admit(requirements)
        self.reserve(requirements)
        if old:
            self.stop(old.id)
        now = self.now()
        monitor = Monitor(uuid.uuid4().hex, client_id, request, codes, leaves, now)
        self.monitors[monitor.id] = monitor
        for code in codes:
            history = self.histories.setdefault(code, History(needed, touched_ms=now))
            if needed > history.needed:
                history.needed, history.fetched_ms = needed, 0
            history.touched_ms = now
        if self.loop_task is None or self.loop_task.done():
            self.loop_task = asyncio.create_task(self.run(), name='screener-continuous')
        return self.status(monitor, now)

    @staticmethod
    def admit(requirements):
        bars = sum(count + 1 for count in requirements.values())
        reserved_bytes = bars * BAR_RESERVATION_BYTES + len(requirements) * REPLAY_RESERVATION_BYTES
        if len(requirements) > MAX_STREAMS or bars > MAX_BARS or reserved_bytes > MAX_BYTES:
            raise HTTPException(409, '감시 이력 용량을 초과했습니다. 종목 범위나 비교 봉 수를 줄여주세요.')

    def reserve(self, requirements):
        combined = {code: max(history.needed, requirements.get(code, 0))
                    for code, history in self.histories.items()}
        combined.update({code: max(combined.get(code, 0), count) for code, count in requirements.items()})
        try:
            self.admit(combined)
        except HTTPException:
            for code in list(self.histories):
                if code not in requirements:
                    self.histories.pop(code)
                    if code in self.pending:
                        self.pending[code].cancel()
            for code, count in requirements.items():
                if code in self.histories and self.histories[code].needed > count:
                    self.histories[code].needed = count
                    candles.trim(self.histories[code])

    async def resolve(self, request):
        scope = await asyncio.to_thread(screener_universe.scope_codes, self.data_dir, request.universe.scopes)
        etfs = symbols.all_etf_etn_codes() if request.universe.exclude_etf else None
        return await asyncio.to_thread(screener_universe.codes_for_universe,
            self.data_dir / 'screener/stocks.parquet', request.universe, scope=scope, etf_codes=etfs)

    def get(self, monitor_id, *, touch=False):
        monitor = self.monitors.get(monitor_id)
        if monitor is None:
            raise HTTPException(404, '감시가 만료되었거나 종료되었습니다. 다시 시작해 주세요.')
        if touch:
            monitor.touched_ms = self.now()
        return monitor

    def stop(self, monitor_id):
        monitor = self.monitors.pop(monitor_id, None)
        if monitor and monitor.result_flight:
            task = monitor.result_flight.task
            if not task.done() and not task.cancelling():
                task.cancel()

    def _require_current(self, monitor):
        if self.closed or self.monitors.get(monitor.id) is not monitor:
            raise HTTPException(404, '감시가 만료되었거나 종료되었습니다. 다시 시작해 주세요.')

    async def _scan_result(self, monitor):
        from hoga.api.screener_runner import run_screener_scan  # noqa: PLC0415 — request assembly

        with monitor_scan(monitor.id):
            return await run_screener_scan(data_dir=self.data_dir,
                req=monitor.request.model_copy(update={'basis': 'intraday'}),
                volume_runtime=ContinuousAdapter(self, monitor))

    async def result(self, monitor_id):
        monitor = self.get(monitor_id)
        while True:
            self._require_current(monitor)
            flight = monitor.result_flight
            if flight and not flight.task.done() and flight.task.cancelling():
                await flight.finished.wait()
                continue
            if flight is None or flight.task.done():
                if len(self.result_tasks) >= MAX_MONITORS:
                    raise HTTPException(409, '진행 중인 감시 결과 작업이 많습니다. 잠시 후 다시 조회해 주세요.')
                task = asyncio.create_task(self._scan_result(monitor), name=f'screener-result-{monitor.id}')
                flight = ResultFlight(task)
                monitor.result_flight = flight
                self.result_tasks.add(task)

                def finished(task, flight=flight):
                    self.result_tasks.discard(task)
                    if monitor.result_flight and monitor.result_flight.task is task:
                        monitor.result_flight = None
                    if not task.cancelled():
                        task.exception()
                    flight.finished.set()

                task.add_done_callback(finished)
            break
        flight.waiters += 1
        try:
            try:
                response = await asyncio.shield(flight.task)
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
                self._require_current(monitor)
                raise
            self._require_current(monitor)
            return response.model_copy(deep=True)
        finally:
            flight.waiters -= 1
            if flight.waiters == 0 and not flight.task.done() and not flight.task.cancelling():
                flight.task.cancel()

    def monitor_quality(self, monitor, code, history, now):
        version = self.version(code, history, now)
        key = monitor.id, code
        quality = self._quality.get(key)
        if quality is None or quality[0] != version:
            ready = self.current_day(history, now) and candles.prepared(history, monitor.leaves, now)
            damaged = candles.damaged(history, monitor.leaves, now)
            quality = version, ready, damaged
            self._quality[key] = quality
        return quality[1:]

    def status(self, monitor, now, *, snapshots=None):
        prepared = receiving = recovering = unavailable = insufficient = preparing = 0
        verified = []
        needed = candles.requirement(monitor.leaves)
        for code in monitor.codes:
            snapshot = snapshots.get(code) if snapshots is not None else None
            history = snapshot or self.histories.get(code, History(needed))
            state = self.replica.get(code, now)
            if snapshot:
                ready = snapshot.current_day and candles.prepared(snapshot, monitor.leaves, snapshot.cutoff_ms)
                damaged = candles.damaged(snapshot, monitor.leaves, snapshot.cutoff_ms)
                receiving_live = snapshot.live_ready
                live_clock = self.live_clock(snapshot.cutoff_ms)
            else:
                ready, damaged = self.monitor_quality(monitor, code, history, now)
                live_clock = self.live_clock(now)
                receiving_live = bool(live_clock and state and state['ready'])
            prepared += ready
            insufficient += bool(not ready and history.reason == 'insufficient_minute_history')
            failed = bool(not ready and history.reason and history.reason != 'insufficient_minute_history')
            unavailable += failed
            preparing += bool(not ready and not history.reason)
            recovering += bool(ready and damaged)
            receiving += bool(ready and not damaged and receiving_live)
            unavailable += bool(ready and live_clock and not receiving_live)
            if history.fetched_ms:
                verified.append(history.fetched_ms)
        return ContinuousStatus(id=monitor.id, total=len(monitor.codes), prepared=prepared, receiving=receiving,
            preparing=preparing, recovering=recovering, unavailable=unavailable,
            insufficient=insufficient,
            last_verified_ms=min(verified) if verified else None, error=self._errors.get(monitor.id))

    def merge(self, code, history, now):
        state = self.replica.get(code, now)
        token = ((self.replica.epoch, state['generation'], state['revision'], state['ready']) if state else None,
                 now // MINUTE, history.fetched_ms, history.needed)
        covered = max(history.source_seen_ms, history.fetched_ms)
        if token == history.merge_token and (not state or covered >= state['replay_since_ms']):
            if state:
                history.source_seen_ms = state['observed_ms']
            return
        before = (list(history.bars), set(history.lower), history.repair_until_ms)
        if state:
            self._merge_state(history, state, now)
        else:
            history.bars = candles.close_minutes(history.bars, history.lower, now)
        history.merge_token = token
        if before != (history.bars, history.lower, history.repair_until_ms):
            history.revision += 1

    def _merge_state(self, history, state, now):
        incoming = candles.source_bars(history, state)
        self.track_source(history, state, now)
        data = {bar.start_ms: bar for bar in history.bars}
        for start, observed, valid, o, h, low, close, prices_complete, _first, last in incoming:
            is_open = start + MINUTE > now and datetime.fromtimestamp(start / 1000, KST).strftime('%H%M') != '1530'
            old = data.get(start)
            previous = history.observed.get(start)
            anchored = bool(previous and previous[2] >= history.baseline_after_ms)
            # A completed authoritative REST bar supersedes older producer state.
            if old and old.valid and not old.is_open and start in history.canonical:
                continue
            if (old and is_open and valid_prices(old) and last <= history.fetched_ms
                    and observed <= old.volume):
                history.observed[start] = (observed, state['revision'], state['observed_ms'], last)
                continue
            if not valid:
                if is_open:
                    delta = max(0, observed - previous[0]) if anchored and old else 0
                    data[start] = volume.VolumeBar(start, max((old.volume + delta) if old else 0, observed),
                                                  True, True)
                    history.lower.add(start)
                else:
                    data[start] = volume.VolumeBar(start, observed, False, False)
            elif old and start in history.lower and anchored and is_open:
                # Both observations are lower bounds; delta since the previous
                # producer snapshot is disjoint from the previous local value.
                delta = max(0, observed - previous[0])
                data[start] = volume.VolumeBar(start, max(observed, old.volume + delta), True, True)
            else:
                data[start] = volume.VolumeBar(start, observed, is_open, True)
                history.lower.discard(start)
            if prices_complete:
                data[start] = replace(data[start], open=o, high=h, low=low, close=close)
            history.observed[start] = (observed, state['revision'], state['observed_ms'], last)
        # Clock closure also occurs without a new trade; never fabricate 0 bars.
        history.bars = candles.close_minutes(sorted(data.values(), key=lambda b: b.start_ms), history.lower, now)
        candles.trim(history)
        retained = {bar.start_ms for bar in history.bars}
        history.lower.intersection_update(retained)
        history.observed = {k: v for k, v in history.observed.items() if k in retained}
        history.canonical = {k: v for k, v in history.canonical.items() if k in retained}

    def track_source(self, history, state, now):
        if (history.source_epoch and (history.source_epoch != self.replica.epoch
                or history.generation != state['generation']) and history.bars and history.bars[-1].is_open
                and history.fetched_ms < state['since_ms']):
            history.bars[-1] = replace(history.bars[-1], valid=False)
        changed = bool(history.source_epoch and (history.source_epoch != self.replica.epoch
                                                  or history.generation != state['generation']))
        covered_until = max(history.source_seen_ms, history.fetched_ms)
        if ((covered_until and covered_until < state['replay_since_ms'])
                or (changed and history.fetched_ms < state['since_ms'])):
            history.repair_until_ms = max(history.repair_until_ms, now)
        history.source_seen_ms = state['observed_ms']
        history.source_epoch, history.generation = self.replica.epoch, state['generation']

    async def prepare(self, code, history):
        now = self.now()
        history.attempt_day = self.selected_day(now).isoformat()
        try:
            repair = self.loader is volume.monitor_day_snapshot and bool(history.fetched_ms or history.failures)
            snapshot = await self.loader(self.data_dir, code, '1m', history.needed, None,
                datetime.fromtimestamp(now / 1000, KST), **({'force': True} if repair else {}))
            if snapshot.reason:
                raise ValueError(snapshot.reason)
            if snapshot.bars:
                if history.bars and candles.session_start(snapshot.bars[-1].start_ms) < candles.session_start(
                        history.bars[-1].start_ms):
                    return  # An overnight REST response cannot overwrite the new session.
                opening = candles.reset_day(history, snapshot.bars[-1].start_ms)
                history.coverage_start_ms = opening
            incoming = self.canonicalize(snapshot, history)
            for bar in history.bars:
                if bar.start_ms not in incoming or (bar.is_open and incoming[bar.start_ms].is_open):
                    if bar.start_ms in incoming:
                        observed = history.observed.get(bar.start_ms)
                        selected = (bar if observed and observed[3] > snapshot.fetched_at_ms
                                    and valid_prices(bar) else incoming[bar.start_ms])
                        incoming[bar.start_ms] = replace(selected,
                            volume=max(bar.volume, incoming[bar.start_ms].volume))
                    else:
                        incoming[bar.start_ms] = bar
            history.bars = sorted(incoming.values(), key=lambda b: b.start_ms)
            candles.trim(history)
            if snapshot.bars and snapshot.fetched_at_ms >= history.repair_until_ms:
                history.repair_until_ms = 0
            history.baseline_after_ms = self.now()
            history.observed.clear()
            history.lower = {b.start_ms for b in history.bars if b.is_open}
            history.fetched_ms, history.reason, history.failures = snapshot.fetched_at_ms, None, 0
            history.retry_at = max(self.now() + 1000, snapshot.fetched_at_ms + volume.MINUTE_TTL_MS + 1)
            self.merge(code, history, self.now())
            if len(history.bars) < history.needed:
                history.reason = 'insufficient_minute_history'
                history.retry_at = self.now() + AUDIT_MS
        except Exception as exc:
            history.failures += 1
            history.reason = str(exc)[:160]
            history.retry_at = self.now() + min(30_000, 1000 * 2 ** min(history.failures, 5))
            log.exception('screener.volume.prepare_failed code=%s reason=%s', code, history.reason)
        finally:
            history.revision += 1
            history.merge_token = None
            self.pending.pop(code, None)

    @staticmethod
    def canonicalize(snapshot, history):
        data = snapshot.bars[-(history.needed + 1):]
        if len(data) < len(snapshot.bars):
            history.coverage_start_ms = max(history.coverage_start_ms, data[0].start_ms)
        incoming = {b.start_ms: b for b in data}
        for stamp, bar in list(incoming.items()):
            if not bar.is_open:
                close = min(stamp + MINUTE, candles.session_start(stamp) + 390 * MINUTE)
                settled = close + CANONICAL_SETTLE_MS <= snapshot.fetched_at_ms
                incoming[stamp] = replace(bar, valid=bar.valid and settled)
                if settled and bar.valid:
                    history.canonical[stamp] = snapshot.fetched_at_ms
                else:
                    history.canonical.pop(stamp, None)
        return incoming

    async def reconcile_scope(self, now):
        for monitor in list(self.monitors.values()):
            try:
                codes = await self.resolve(monitor.request)
                needed = candles.requirement(monitor.leaves)
                requirements = {code: history.needed for code, history in self.histories.items()
                                if now - history.touched_ms < LEASE_MS}
                for code in codes:
                    requirements[code] = max(requirements.get(code, 0), needed)
                self.admit(requirements)
                for code in codes:
                    history = self.histories.setdefault(code, History(needed, touched_ms=now))
                    if needed > history.needed:
                        history.needed, history.fetched_ms = needed, 0
                monitor.codes = codes
                self._errors.pop(monitor.id, None)
            except Exception:
                log.exception('screener.volume.scope_refresh_failed')
                self._errors[monitor.id] = '범위 갱신 실패 또는 용량 초과: 기존 감시 범위를 유지합니다.'

    def collect_active(self, now):
        for key, monitor in list(self.monitors.items()):
            if now - monitor.touched_ms > LEASE_MS:
                self.stop(key)
        active = {code for m in self.monitors.values() for code in m.codes}
        for code in active:
            self.histories[code].touched_ms = now
        for code, task in self.pending.items():
            if code not in active:
                task.cancel()
        for code, history in list(self.histories.items()):
            if code not in active and now - history.touched_ms > LEASE_MS:
                self.histories.pop(code)
        return active

    async def step(self):
        now = self.now()
        active = self.collect_active(now)
        if now - self._last_targets >= TARGET_REFRESH_MS:
            await self.set_targets(set(self.histories))
            self._last_targets = now
        if now - self._last_scope >= SCOPE_REFRESH_MS:
            await self.reconcile_scope(now)
            self._last_scope = now
        for code in active:
            self.merge(code, self.histories[code], now)
        self.schedule(active, now)
        self.notify()

    @staticmethod
    def market_clock(now):
        clock = datetime.fromtimestamp(now / 1000, KST)
        # Allow the final auction/settlement repair, then retain memory without
        # polling the full universe throughout the night or weekend.
        return clock.weekday() < 5 and 900 <= clock.hour * 100 + clock.minute <= 1535  # noqa: PLR2004

    def schedule(self, active, now):
        candidates = []
        opened = (self.market_clock(now)
                  and self.selected_day(now) == datetime.fromtimestamp(now / 1000, KST).date())
        for code in active:
            history = self.histories[code]
            if (code in self.pending or now < history.retry_at
                    or (not opened and (history.fetched_ms or history.failures)
                        and history.attempt_day == self.selected_day(now).isoformat())):
                continue
            damaged = any(candles.damaged(history, monitor.leaves, now)
                          for monitor in self.monitors.values() if code in monitor.codes)
            short = not self.current_day(history, now) or any(
                        code in monitor.codes and not self.monitor_quality(monitor, code, history, now)[0]
                        for monitor in self.monitors.values())
            if not history.fetched_ms or damaged or (short and now - history.fetched_ms >= AUDIT_MS):
                candidates.append((bool(history.fetched_ms and not damaged), history.fetched_ms, code))
        for _, _, code in sorted(candidates)[:max(0, 4 - len(self.pending))]:
            self.pending[code] = asyncio.create_task(self.prepare(code, self.histories[code]))
    def version(self, code, history, now):
        state = self.replica.get(code, now)
        closing = candles.session_start(history.bars[-1].start_ms) + 390 * MINUTE if history.bars else now
        return (history.identity, history.revision, history.fetched_ms, history.reason, history.repair_until_ms,
                history.source_epoch, history.generation, len(history.bars),
                min(now, closing) // MINUTE, bool(state and state['ready']), self.selected_day(now))

    def notify(self):
        now = self.now()
        active = set(self.monitors)
        self._fingerprints = {key: value for key, value in self._fingerprints.items() if key in active}
        self._quality = {key: value for key, value in self._quality.items() if key[0] in active}
        for monitor in self.monitors.values():
            cached = self._fingerprints.setdefault(monitor.id, {})
            signature = []
            for code in monitor.codes:
                history = self.histories[code]
                version = self.version(code, history, now)
                if code not in cached or cached[code][0] != version:
                    cached[code] = version, self.match_fingerprint(monitor, history, now)
                signature.append((code, history.fetched_ms, cached[code][1], version[-2],
                                  history.reason, bool(history.repair_until_ms), version[-1]))
            signature = tuple(signature)
            cached_keys = set(monitor.codes)
            for code in cached.keys() - cached_keys:
                del cached[code]
            if signature != monitor.fingerprint:
                monitor.fingerprint = signature
                if self.bus:
                    self.bus.publish({'type': 'screener_volume_changed',
                        'condition_ids': [item.id for item in monitor.leaves], 'monitor_id': monitor.id})

    @staticmethod
    def match_fingerprint(monitor, history, now=None):
        bars = history.bars
        if not bars:
            return ()
        flags, windows = [], []
        for leaf in monitor.leaves:
            bars, _ = candles.window(history, leaf, now if now is not None else history.bars[-1].start_ms)
            if leaf.type in CHANGE_TYPES:
                events, complete = volume.records(leaf, bars, fetched_at_ms=0)
                flags.append(bool(events))
                windows.append((bars[-1].start_ms, bars[-1].is_open, complete))
                continue
            previous = bars[-leaf.params.period:-1]
            known = len(previous) == leaf.params.period - 1 and all(b.valid for b in previous)
            threshold = max((b.volume for b in previous), default=0)
            flags.append(known and bars[-1].valid and bars[-1].volume > 0 and bars[-1].volume >= threshold)
            windows.append((bars[-1].start_ms, bars[-1].is_open,
                            all(b.valid for b in bars[-candles.candle_count(leaf):])))
        return (tuple(windows), not history.repair_until_ms, tuple(flags))

    async def run(self):
        while not self.closed:
            try:
                await self.step()
            except Exception:
                log.exception('screener.volume.coordinator_failed')
            if not self.monitors and not self.histories:
                return
            await asyncio.sleep(0.25 if self.market_clock(self.now()) else 1)

    async def close(self):
        self.closed = True
        for monitor_id in list(self.monitors):
            self.stop(monitor_id)
        self.evaluations.clear()
        self._event_count = 0
        self._fingerprints.clear()
        self._quality.clear()
        tasks = (list(self.pending.values()) + list(self.evaluation_flights.values()) + list(self.result_tasks)
                 + ([self.loop_task] if self.loop_task else []))
        for task in tasks:
            if not task.cancelling():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        with contextlib.suppress(ConnectionError, TimeoutError):
            await self.set_targets(set())


def build_router(owner):
    router = APIRouter(prefix='/monitors')
    if owner is None:
        return router

    @router.post('')
    async def start(body: ContinuousStartRequest) -> ContinuousStatus:
        return await owner.start(body.client_id, body.request)

    @router.post('/{monitor_id}/heartbeat')
    async def heartbeat(monitor_id: str) -> ContinuousStatus:
        return owner.status(owner.get(monitor_id, touch=True), owner.now())

    @router.get('/{monitor_id}/result')
    async def result(monitor_id: str) -> ScreenerResponse:
        return await owner.result(monitor_id)

    @router.delete('/{monitor_id}', status_code=204)
    async def stop(monitor_id: str) -> None:
        owner.stop(monitor_id)

    return router


def make_owner(data_dir, bus, live_buffer, volume_targets):
    if live_buffer is None or volume_targets is None:
        return None
    return ContinuousMonitors(data_dir, bus, live_buffer, volume_targets)
