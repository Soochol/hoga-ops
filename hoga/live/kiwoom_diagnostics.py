"""Payload-free failure evidence: bounded counters, CPU window and optional GC.

CPU deltas cover the owning process / reader's event-loop thread, not the
Kiwoom task. Rates count REAL frames/raw data rows versus completed frames/parsed
callback-completed ticks; these are different units. Snapshots are captured only
on terminal control, reader or consumer failure.
"""
from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Literal

from .kiwoom_failure_evidence import exception_family, number, numeric_fields, runtime_projection
from .latency import LatencySamples

_WINDOW_S = 10.0


class _Context:
    provider: Callable[[], dict] | None = None


_context = _Context()


def configure_failure_context(provider: Callable[[], dict] | None) -> None:
    """Lifespan supplies commit/live start/GC, without live importing API modules."""
    _context.provider = provider


def failure_context() -> dict:
    if _context.provider is None:
        return {"runtime_context": "not_wired"}
    try:
        source = _context.provider()
        result = runtime_projection(source)
        if type(source) is dict and type(source.get('collector_loop')) is dict:
            result['collector_loop'] = loop_projection(source['collector_loop'])
        return result
    except BaseException as exc:  # noqa: BLE001 — synchronous diagnostics cannot mask failure
        return {"runtime_context_error": exception_family(exc)[1]}


@dataclass(frozen=True, slots=True)
class _Sample:
    at: float
    received_frames: int
    received_rows: int
    completed_frames: int
    processed_ticks: int
    process_cpu: float
    loop_thread_cpu: float


class QueueFlowEvidence:
    def __init__(self, now: float) -> None:
        self.received_frames = 0
        self.received_rows = 0
        self.completed_frames = 0
        self.processed_ticks = 0
        self.inflight_started_at: float | None = None
        self.inflight_rows = 0
        self.inflight_ticks = 0
        self._samples: deque[_Sample] = deque(maxlen=12)
        self._sample(now)

    def _sample(self, now: float) -> None:
        if self._samples and now - self._samples[-1].at < 1.0:
            return
        self._samples.append(self._current(now))

    def _current(self, now: float) -> _Sample:
        return _Sample(now, self.received_frames, self.received_rows,
                       self.completed_frames, self.processed_ticks,
                       time.process_time(), time.thread_time())

    def receive(self, rows: int, now: float) -> None:
        self._sample(now)
        self.received_frames += 1
        self.received_rows += rows

    def start_frame(self, rows: int, now: float) -> None:
        self.inflight_started_at = now
        self.inflight_rows = rows
        self.inflight_ticks = 0

    def tick(self) -> None:
        self.processed_ticks += 1
        self.inflight_ticks += 1

    def complete_frame(self, now: float) -> None:
        self.completed_frames += 1
        self.inflight_started_at = None
        self._sample(now)

    def snapshot(self, now: float) -> dict:
        while len(self._samples) > 1 and self._samples[1].at <= now - _WINDOW_S:
            self._samples.popleft()
        before, current = self._samples[0], self._current(now)
        seconds = max(0.0, now - before.at)
        incoming = current.received_frames - before.received_frames
        completed = current.completed_frames - before.completed_frames
        inflight_age = max(0.0, now - self.inflight_started_at) if self.inflight_started_at is not None else 0
        return {
            "window_ms": round(seconds * 1000, 1),
            "received_frames": self.received_frames,
            "received_raw_rows": self.received_rows,
            "completed_frames": self.completed_frames,
            "processed_ticks": self.processed_ticks,
            "recent_received_frames": incoming,
            "recent_completed_frames": completed,
            "input_frames_per_s": round(incoming / seconds, 1) if seconds else 0,
            "completed_frames_per_s": round(completed / seconds, 1) if seconds else 0,
            "process_cpu_ms": round(max(0.0, current.process_cpu - before.process_cpu) * 1000, 1),
            "loop_thread_cpu_ms": round(max(0.0, current.loop_thread_cpu - before.loop_thread_cpu) * 1000, 1),
            "inflight_age_ms": round(inflight_age * 1000, 1),
            "inflight_raw_rows": self.inflight_rows if self.inflight_started_at is not None else 0,
            "inflight_processed_ticks": self.inflight_ticks if self.inflight_started_at is not None else 0,
        }


@dataclass(slots=True)
class ControlAttempt:
    sequence: int
    kind: str
    item_count: int | None
    started_at: float
    stages: dict[str, float] = field(default_factory=dict)

    def snapshot(self, now: float) -> dict:
        result = {'sequence': self.sequence, 'kind': self.kind, 'item_count': self.item_count,
                  'started_at': self.started_at, 'age_ms': max(0.0, (now - self.started_at) * 1000),
                  **self.stages}
        for name, begin, end in (
            ('send_wall_ms', 'send_begin', 'send_returned'),
            ('recv_to_parse_ms', 'recv_returned', 'parsed'),
            ('parse_to_match_ms', 'parsed', 'ack_matched'),
            ('match_to_resolve_ms', 'ack_matched', 'future_resolved'),
            ('resolve_to_resume_ms', 'future_resolved', 'sender_resumed'),
        ):
            result[name] = (max(0.0, (self.stages[end] - self.stages[begin]) * 1000)
                            if begin in self.stages and end in self.stages else None)
        return result


@dataclass(slots=True)
class ProgressEvidence:
    reader_phase: Literal['waiting_recv', 'parsing', 'control', 'ping_echo', 'inactive'] = 'inactive'
    reader_started_at: float | None = None
    consumer_phase: Literal['dispatch', 'callback', 'inactive'] = 'inactive'
    consumer_started_at: float | None = None
    last_recv_at: float | None = None
    last_control_at: float | None = None
    reader_processing_ms: float | None = None
    callback_wall: LatencySamples = field(default_factory=lambda: LatencySamples(32))

    def snapshot(self, now: float) -> dict:
        def age(at: float | None) -> float | None:
            return max(0.0, (now - at) * 1000) if at is not None else None
        return {
            'reader': {'phase': self.reader_phase, 'started_at': self.reader_started_at,
                       'age_ms': age(self.reader_started_at), 'processing_ms': self.reader_processing_ms},
            'consumer': {'phase': self.consumer_phase, 'started_at': self.consumer_started_at,
                         'age_ms': age(self.consumer_started_at), 'callback_wall': self.callback_wall.snapshot()},
            'last_application_recv_age_ms': age(self.last_recv_at),
            'last_classified_control_age_ms': age(self.last_control_at),
        }


def loop_projection(source: dict) -> dict:
    state = source.get('state')
    result = numeric_fields(source, ('interval_ms', 'last_observation_age_ms', 'pending_deadline',
                                      'pending_overdue_ms', 'window_ms', 'latest_ms', 'max_ms'))
    states = ('unobserved', 'active', 'stopped', 'failed')
    result['state'] = state if type(state) is str and state in states else 'unobserved'
    if result['state'] != 'active':
        result.update(pending_deadline=None, pending_overdue_ms=None)
    samples = source.get('samples')
    result['samples'] = ([numeric_fields(row, ('at', 'lag_ms')) for row in samples[-32:]]
                         if type(samples) in (list, tuple) else [])
    return result


class LoopLagEvidence:
    """One log-free collector timer. Pending overdue is observed synchronously."""

    def __init__(self, interval_s: float = 1.0, clock: Callable[[], float] = time.monotonic) -> None:
        self.interval_s = interval_s
        self.clock = clock
        self.state: Literal['unobserved', 'active', 'stopped', 'failed'] = 'unobserved'
        self.deadline: float | None = None
        self.last_observation: float | None = None
        self.samples: deque[tuple[float, float]] = deque(maxlen=32)

    async def run(self) -> None:
        try:
            from hoga.api.loop_lag import overshoot_ms  # noqa: PLC0415 — reuse the existing timer semantics
            self.state = 'active'
            while True:
                started = self.clock()
                self.deadline = started + self.interval_s
                await asyncio.sleep(self.interval_s)
                now = self.clock()
                self.last_observation = now
                self.samples.append((now, overshoot_ms(now - started, self.interval_s)))
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 — optional diagnostics never stop required capture
            self.state = 'failed'
        finally:
            self.deadline = None
            if self.state != 'failed':
                self.state = 'stopped'

    def snapshot(self) -> dict:
        now = self.clock()
        return {
            'state': self.state, 'interval_ms': number(self.interval_s * 1000),
            'last_observation_age_ms': number(max(0.0, (now - self.last_observation) * 1000))
            if self.last_observation is not None else None,
            'pending_deadline': self.deadline if self.state == 'active' else None,
            'pending_overdue_ms': number(max(0.0, (now - self.deadline) * 1000))
            if self.state == 'active' and self.deadline is not None else None,
            'samples': [{'at': at, 'lag_ms': lag} for at, lag in self.samples],
            'window_ms': max(0.0, (self.samples[-1][0] - self.samples[0][0]) * 1000) if self.samples else 0.0,
            'latest_ms': self.samples[-1][1] if self.samples else None,
            'max_ms': max((lag for _, lag in self.samples), default=None),
        }
