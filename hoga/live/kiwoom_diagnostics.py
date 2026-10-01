"""Payload-free failure evidence: bounded counters, CPU window and optional GC.

CPU deltas cover the whole parent process / reader's event-loop thread, not the
Kiwoom task. Rates count REAL frames/raw data rows versus completed frames/parsed
callback-completed ticks; these are different units. Snapshots are captured only
on queue failure.
"""
from __future__ import annotations

import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass

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
        return _context.provider()
    except Exception as exc:  # noqa: BLE001 — diagnostics must not mask queue failure
        return {"runtime_context_error": type(exc).__name__}


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
