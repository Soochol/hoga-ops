"""Capture timing collector — per (code, date) wall-time attribution.

See docs/superpowers/specs/2026-05-27-capture-timing-instrumentation-design.md
"""
from __future__ import annotations

import time
from contextlib import contextmanager
from typing import Callable, Iterator, Literal

PhaseName = Literal[
    "http_fetch",
    "parse",
    "disk_write",
    "rate_limit",
    "backoff",
    "cookie_pause",
    "other",
]

_PHASES: tuple[PhaseName, ...] = (
    "http_fetch",
    "parse",
    "disk_write",
    "rate_limit",
    "backoff",
    "cookie_pause",
    "other",
)


class CaptureTimingCollector:
    """Thread-safe-by-isolation per-(code, date) timing aggregator.

    Each capture worker creates one instance; the instance never crosses
    workers. Phases are measured with a monotonic clock; nesting is disallowed
    so a `phase()` re-entry while another is active raises RuntimeError —
    this catches accidental misuse where time would be double-counted.
    """

    def __init__(
        self,
        code: str,
        date: str,
        *,
        clock: Callable[[], float] = time.perf_counter,
    ) -> None:
        self.code = code
        self.date = date
        self._clock = clock
        self._started = clock()
        self._active_phase: PhaseName | None = None
        self.phase_totals_ms: dict[PhaseName, float] = {p: 0.0 for p in _PHASES}

    @contextmanager
    def phase(self, name: PhaseName) -> Iterator[None]:
        if self._active_phase is not None:
            raise RuntimeError(
                f"timing phase {name!r} entered while {self._active_phase!r} is active; "
                f"nesting is not allowed"
            )
        self._active_phase = name
        start = self._clock()
        try:
            yield
        finally:
            elapsed_ms = (self._clock() - start) * 1000.0
            self.phase_totals_ms[name] += elapsed_ms
            self._active_phase = None
