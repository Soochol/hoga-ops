"""Capture timing collector — per (code, date) wall-time attribution.

See docs/superpowers/specs/2026-05-27-capture-timing-instrumentation-design.md
"""
from __future__ import annotations

import datetime as _dt
import time
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass, field
from typing import Callable, ContextManager, Iterator, Literal
from zoneinfo import ZoneInfo

from hoga.api.models import (
    TimingEnv,
    TimingPageDetail,
    TimingPhaseTotals,
    TimingReport,
    TimingSummary,
)

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

_KST = ZoneInfo("Asia/Seoul")


def _now_kst_iso() -> str:
    return _dt.datetime.now(_KST).isoformat(timespec="seconds")


@dataclass
class PageTiming:
    idx: int
    http_ms: float = 0.0
    parse_ms: float = 0.0
    write_ms: float = 0.0
    events: int = 0
    errors: list[str] = field(default_factory=list)


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
        self.pages: list[PageTiming] = []
        self.error_counts: dict[str, int] = {}
        self.event_count: int = 0
        self._started_at_kst = _now_kst_iso()

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
            current_page = self.pages[-1] if self.pages else None
            if current_page is not None:
                if name == "http_fetch":
                    current_page.http_ms += elapsed_ms
                elif name == "parse":
                    current_page.parse_ms += elapsed_ms
                elif name == "disk_write":
                    current_page.write_ms += elapsed_ms
            self._active_phase = None

    def mark_page_boundary(self) -> None:
        self.pages.append(PageTiming(idx=len(self.pages)))

    def record_event_count(self, n: int) -> None:
        if not self.pages:
            self.mark_page_boundary()
        self.pages[-1].events += n
        self.event_count += n

    def record_error(self, kind: str) -> None:
        self.error_counts[kind] = self.error_counts.get(kind, 0) + 1
        if self.pages:
            self.pages[-1].errors.append(kind)

    def summary(self, *, env: TimingEnv, ended_at_kst: str | None = None) -> TimingSummary:
        total_ms = (self._clock() - self._started) * 1000.0
        phase_sum = sum(self.phase_totals_ms.values())
        unaccounted = max(0.0, total_ms - phase_sum)

        denom = total_ms if total_ms > 0 else 1.0
        phase_percentages = {
            phase: (self.phase_totals_ms[phase] / denom) * 100.0
            for phase in _PHASES
        }

        return TimingSummary(
            code=self.code,
            date=self.date,
            started_at_kst=self._started_at_kst,
            ended_at_kst=ended_at_kst or _now_kst_iso(),
            total_ms=total_ms,
            phase_totals_ms=TimingPhaseTotals(
                http_fetch_ms=self.phase_totals_ms["http_fetch"],
                parse_ms=self.phase_totals_ms["parse"],
                disk_write_ms=self.phase_totals_ms["disk_write"],
                rate_limit_ms=self.phase_totals_ms["rate_limit"],
                backoff_ms=self.phase_totals_ms["backoff"],
                cookie_pause_ms=self.phase_totals_ms["cookie_pause"],
                other_ms=self.phase_totals_ms["other"],
            ),
            phase_percentages=phase_percentages,
            unaccounted_ms=unaccounted,
            page_count=len(self.pages),
            event_count=self.event_count,
            error_counts=dict(self.error_counts),
            env=env,
        )

    def to_report(self, *, env: TimingEnv, ended_at_kst: str | None = None) -> TimingReport:
        return TimingReport(
            summary=self.summary(env=env, ended_at_kst=ended_at_kst),
            pages=[
                TimingPageDetail(
                    idx=p.idx,
                    http_ms=p.http_ms,
                    parse_ms=p.parse_ms,
                    write_ms=p.write_ms,
                    events=p.events,
                    errors=list(p.errors),
                )
                for p in self.pages
            ],
        )


class NullTimingCollector:
    """No-op collector used when capture timing is disabled (HOGA_CAPTURE_TIMING=0).

    Substituting this for ``None`` lets every ingest call site use
    ``with collector.phase(...)`` / ``collector.record_*()`` unconditionally —
    the on/off decision lives once at construction instead of being re-tested
    at ~10 branch points. The report-emit gate stays separate (see
    ``_timing_enabled`` in ``hoga/api/captures.py``), so disabling timing still
    writes no JSON and emits no SSE event.

    Unlike :class:`CaptureTimingCollector`, ``phase()`` does NOT forbid
    nesting: the Null object measures nothing, so a (hypothetical) nested
    ``with`` is harmless rather than a double-count bug to catch.
    """

    def phase(self, name: PhaseName) -> ContextManager[None]:
        return nullcontext()

    def mark_page_boundary(self) -> None:
        pass

    def record_event_count(self, n: int) -> None:
        pass

    def record_error(self, kind: str) -> None:
        pass
