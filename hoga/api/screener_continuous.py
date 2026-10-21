"""Server-owned scoped minute-volume monitors and shared memory history.

Preparation/repair has its own bounded background queue. Reading a supported
volume result never initiates a vendor fetch; legacy predicates keep their path.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time
import uuid
from dataclasses import dataclass, field, replace
from datetime import datetime

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from hoga.api import screener_bar_volume as volume, screener_expression, screener_universe, symbols
from hoga.api.models import ScanRequest, ScreenerResponse
from hoga.live.volume_state import MINUTE, VolumeReplica
from hoga.util.timeenc import KST

log = logging.getLogger(__name__)
MAX_MONITORS = 32
MAX_STREAMS = 512
MAX_BARS = 250_000
MAX_BYTES = 64 * 1024 * 1024
BAR_RESERVATION_BYTES = 512  # Conservative admission includes objects, indexes and evidence.
LEASE_MS = 300_000
AUDIT_MS = 300_000
TARGET_REFRESH_MS = 1000
SCOPE_REFRESH_MS = 30_000
CANONICAL_SETTLE_MS = 15_000


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


@dataclass
class Monitor:
    id: str
    client_id: str
    request: ScanRequest
    codes: list[str]
    leaves: list
    touched_ms: int
    fingerprint: tuple = ()


class ContinuousAdapter:
    def __init__(self, owner, monitor):
        self.owner, self.monitor = owner, monitor
        self.coverage_monitor = monitor

    @staticmethod
    def supports(leaf):
        return (leaf.type in {'new_high_vol', 'new_high_vol_today'}
                and leaf.params.timeframe == '1m' and not hasattr(leaf.params, 'mode')
                and leaf.params.include_open_bar)

    def snapshot(self, leaf, code, now):
        history = self.owner.histories.get(code)
        # An empty tuple snapshot is deliberate: the scan cannot turn preparation
        # into another REST fan-out. Quality/coverage carries the unknown state.
        if not history:
            return [], now, set()
        self.owner.merge(code, history, now)
        state = self.owner.replica.get(code, now)
        data = list(history.bars)
        if not state or not state['ready'] or history.repair_until_ms:
            data = [volume.VolumeBar(b.start_ms, b.volume, b.is_open, False) for b in data]
        return data[-(leaf.params.period + getattr(leaf.params, 'lookback', 1)):], now, set(history.lower)

    def seed(self, *args):
        pass  # Preparation belongs exclusively to the background coordinator.

    def counts(self, leaves, codes, now):
        self.coverage_monitor = replace(self.monitor, codes=list(codes))
        status = self.owner.status(self.coverage_monitor, now)
        return status.prepared, status.receiving

    def reason(self, code):
        history = self.owner.histories.get(code)
        if history and history.reason and (not history.fetched_ms or len(history.bars) < history.needed):
            return history.reason
        if not history or not history.fetched_ms:
            return 'volume_preparing'
        if len(history.bars) < history.needed:
            return history.reason or 'insufficient_minute_history'
        return None

    def coverage(self):
        status = self.owner.status(self.coverage_monitor, self.owner.now())
        return {**status.model_dump(exclude={'id', 'total', 'error'}), 'monitor_error': status.error}


class ContinuousMonitors:
    def __init__(self, data_dir, bus, buffer, set_targets, *, loader=None, now=None):
        self.data_dir, self.bus, self.buffer, self.set_targets = data_dir, bus, buffer, set_targets
        self.replica: VolumeReplica = buffer.volume_replica
        self.loader = loader or volume.minute_snapshot
        self.now = now or (lambda: int(time.time() * 1000))
        self.monitors: dict[str, Monitor] = {}
        self.histories: dict[str, History] = {}
        self.pending: dict[str, asyncio.Task] = {}
        self.loop_task: asyncio.Task | None = None
        self.closed = False
        self._last_targets = 0
        self._last_scope = 0
        self._errors: dict[str, str] = {}

    async def start(self, client_id, request):
        leaves = [leaf for leaf in screener_expression.active_conditions(request.conditions, request.expression)
                  if ContinuousAdapter.supports(leaf)]
        if not leaves or not request.universe.scopes or request.basis == 'eod':
            raise HTTPException(422, '1분봉 신고거래량 감시는 관심종목·히트맵 범위를 선택해야 합니다.')
        old = next((m for m in self.monitors.values() if m.client_id == client_id), None)
        if old and old.request == request:
            old.touched_ms = self.now()
            return self.status(old, self.now())
        if len(self.monitors) >= MAX_MONITORS and old is None:
            raise HTTPException(409, '동시 감시 개수 한도를 초과했습니다.')
        codes = await self.resolve(request)
        needed = max(leaf.params.period + getattr(leaf.params, 'lookback', 1) - 1 for leaf in leaves)
        requirements = {code: needed for code in codes}
        for monitor in self.monitors.values():
            if monitor is old:
                continue
            count = max(item.params.period + getattr(item.params, 'lookback', 1) - 1 for item in monitor.leaves)
            for code in monitor.codes:
                requirements[code] = max(requirements.get(code, 0), count)
        self.admit(requirements)
        self.reserve(requirements)
        if old:
            self.monitors.pop(old.id)
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
        bars = sum(requirements.values())
        if len(requirements) > MAX_STREAMS or bars > MAX_BARS or bars * BAR_RESERVATION_BYTES > MAX_BYTES:
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
                    self.histories[code].bars = self.histories[code].bars[-(count + 1):]

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
        self.monitors.pop(monitor_id, None)

    def status(self, monitor, now):
        prepared = receiving = recovering = unavailable = insufficient = preparing = 0
        verified = []
        needed = max(item.params.period + getattr(item.params, 'lookback', 1) - 1 for item in monitor.leaves)
        for code in monitor.codes:
            history = self.histories.get(code, History(needed))
            state = self.replica.get(code, now)
            ready = len(history.bars) >= needed and history.fetched_ms > 0
            prepared += ready
            insufficient += bool(not ready and history.reason == 'insufficient_minute_history')
            failed = bool(not ready and history.reason and history.reason != 'insufficient_minute_history')
            unavailable += failed
            preparing += bool(not ready and not history.reason)
            damaged = bool(history.repair_until_ms) or any(not b.valid for b in history.bars[-needed:])
            recovering += bool(ready and damaged)
            receiving += bool(ready and not damaged and state and state['ready'])
            unavailable += bool(ready and (not state or not state['ready']))
            if history.fetched_ms:
                verified.append(history.fetched_ms)
        return ContinuousStatus(id=monitor.id, total=len(monitor.codes), prepared=prepared, receiving=receiving,
            preparing=preparing, recovering=recovering, unavailable=unavailable,
            insufficient=insufficient,
            last_verified_ms=min(verified) if verified else None, error=self._errors.get(monitor.id))

    def merge(self, code, history, now):
        state = self.replica.get(code, now)
        if not state:
            return
        self.track_source(history, state, now)
        data = {bar.start_ms: bar for bar in history.bars}
        for start, observed, valid in state['bars']:
            is_open = start + MINUTE > now and datetime.fromtimestamp(start / 1000, KST).strftime('%H%M') != '1530'
            old = data.get(start)
            previous = history.observed.get(start)
            anchored = bool(previous and previous[2] >= history.baseline_after_ms)
            # A completed authoritative REST bar supersedes older producer state.
            if old and old.valid and not old.is_open and start in history.canonical:
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
            history.observed[start] = (observed, state['revision'], state['observed_ms'])
        # Clock closure also occurs without a new trade; never fabricate 0 bars.
        for start, bar in list(data.items()):
            if bar.is_open and start + MINUTE <= now:
                data[start] = replace(bar, is_open=False, valid=bar.valid and start not in history.lower)
        history.bars = sorted(data.values(), key=lambda b: b.start_ms)[-(history.needed + 1):]
        retained = {bar.start_ms for bar in history.bars}
        history.lower.intersection_update(retained)
        history.observed = {k: v for k, v in history.observed.items() if k in retained}
        history.canonical = {k: v for k, v in history.canonical.items() if k in retained}
        window = history.bars[-history.needed:]
        if (len(window) == history.needed and window[0].start_ms >= history.repair_until_ms
                and all(bar.valid for bar in window)):
            history.repair_until_ms = 0

    def track_source(self, history, state, now):
        if (history.source_epoch and (history.source_epoch != self.replica.epoch
                or history.generation != state['generation']) and history.bars and history.bars[-1].is_open):
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
        try:
            snapshot = await self.loader(self.data_dir, code, '1m', history.needed, None,
                                         datetime.fromtimestamp(now / 1000, KST))
            if snapshot.reason:
                raise ValueError(snapshot.reason)
            incoming = self.canonicalize(snapshot, history)
            for bar in history.bars:
                if bar.start_ms not in incoming or (bar.is_open and incoming[bar.start_ms].is_open):
                    if bar.start_ms in incoming:
                        incoming[bar.start_ms] = replace(
                            bar, volume=max(bar.volume, incoming[bar.start_ms].volume))
                    else:
                        incoming[bar.start_ms] = bar
            history.bars = sorted(incoming.values(), key=lambda b: b.start_ms)[-(history.needed + 1):]
            if len(snapshot.bars) >= history.needed:
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
            self.pending.pop(code, None)

    @staticmethod
    def canonicalize(snapshot, history):
        incoming = {b.start_ms: b for b in snapshot.bars[-(history.needed + 1):]}
        for stamp, bar in list(incoming.items()):
            if not bar.is_open:
                settled = stamp + MINUTE + CANONICAL_SETTLE_MS <= snapshot.fetched_at_ms
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
                needed = max(item.params.period + getattr(item.params, 'lookback', 1) - 1 for item in monitor.leaves)
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
                self.monitors.pop(key)
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
        opened = self.market_clock(now)
        for code in active:
            history = self.histories[code]
            if (code in self.pending or now < history.retry_at
                    or (not opened and (history.fetched_ms or history.failures))):
                continue
            damaged = bool(history.repair_until_ms) or any(not b.valid for b in history.bars[-history.needed:])
            if not history.fetched_ms or damaged or now - history.fetched_ms >= AUDIT_MS:
                candidates.append((bool(history.fetched_ms and not damaged), history.fetched_ms, code))
        for _, _, code in sorted(candidates)[:max(0, 4 - len(self.pending))]:
            self.pending[code] = asyncio.create_task(self.prepare(code, self.histories[code]))
    def notify(self):
        now = self.now()
        for monitor in self.monitors.values():
            signature = tuple((code, self.histories[code].fetched_ms,
                               self.match_fingerprint(monitor, self.histories[code]),
                               bool((self.replica.get(code, now) or {}).get('ready'))) for code in monitor.codes)
            if signature != monitor.fingerprint:
                monitor.fingerprint = signature
                if self.bus:
                    self.bus.publish({'type': 'screener_volume_changed',
                        'condition_ids': [item.id for item in monitor.leaves], 'monitor_id': monitor.id})

    @staticmethod
    def match_fingerprint(monitor, history):
        bars = history.bars
        if not bars:
            return ()
        flags = []
        for leaf in monitor.leaves:
            previous = bars[-leaf.params.period:-1]
            known = len(previous) == leaf.params.period - 1 and all(b.valid for b in previous)
            threshold = max((b.volume for b in previous), default=0)
            flags.append(known and bars[-1].valid and bars[-1].volume > 0 and bars[-1].volume >= threshold)
        return (bars[-1].start_ms, bars[-1].is_open,
                not history.repair_until_ms and all(b.valid for b in bars), tuple(flags))

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
        tasks = list(self.pending.values()) + ([self.loop_task] if self.loop_task else [])
        for task in tasks:
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
        from hoga.api.screener_runner import run_screener_scan  # noqa: PLC0415 — request assembly
        monitor = owner.get(monitor_id)
        return await run_screener_scan(data_dir=owner.data_dir,
                                       req=monitor.request.model_copy(update={'basis': 'intraday'}),
                                       volume_runtime=ContinuousAdapter(owner, monitor))

    @router.delete('/{monitor_id}', status_code=204)
    async def stop(monitor_id: str) -> None:
        owner.stop(monitor_id)

    return router


def make_owner(data_dir, bus, live_buffer, volume_targets):
    if live_buffer is None or volume_targets is None:
        return None
    return ContinuousMonitors(data_dir, bus, live_buffer, volume_targets)
