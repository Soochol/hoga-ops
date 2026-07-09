"""Concurrency guard for the expensive dual ask/bid peak query.

Why this exists (measured 2026-07-07): ``query_day_ask_bid_peak_dual`` on a
pathological day (small-cap limit-up, e.g. ``000660/20260623``) materialises an
inequality join plus unbounded windows and peaks at ~17GB RSS / ~155s. The
``/api/range`` route is a sync ``def`` served from FastAPI's thread pool, and
``QueryEngine.conn`` hands out an independent cursor per access over ONE shared
in-memory database whose ``memory_limit`` is a single SOFT budget. So N
concurrent sidecar polls — today's peak is uncached by design (ADR-0043) and
focus/reconnect refetch bursts fan out — run N of these in parallel and blow
past the shared limit collectively. That is the observed ~87GB (~17GB x 5) OOM.

The guard bounds that two ways:
  * a process-wide ``BoundedSemaphore`` caps how many heavy peak computes run
    at once (default 2, env ``HOGA_PEAK_QUERY_CONCURRENCY``);
  * per-key single-flight collapses concurrent identical
    ``(code, date, source, bucket_ms)`` computes into one shared result.

Single-flight retains nothing past the in-flight window, so it adds zero
staleness and honours the "today is never cached" contract of
``past_indicators_cache``. This is an INTERIM mitigation, not a guarantee:
``memory_limit`` is soft, so a single future day worse than ``000660`` could
still exceed one-query RSS. The linear-sweep rewrite of the query removes that
ceiling.
"""
from __future__ import annotations

import os
import threading
from collections.abc import Callable, Hashable
from typing import Generic, TypeVar

T = TypeVar("T")

DEFAULT_CONCURRENCY = 2


def _resolve_concurrency(env_name: str, default: int) -> int:
    raw = os.environ.get(env_name)
    if raw is None:
        return default
    try:
        return max(1, int(raw))
    except ValueError:
        return default


class _Flight(Generic[T]):
    __slots__ = ("done", "result", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: T | None = None
        self.error: BaseException | None = None


class SliceCoalescer:
    """Per-key single-flight (no concurrency cap) around a compute keyed by a
    hashable.

    Concurrent callers sharing ``key`` execute ``compute`` exactly once and all
    receive that result (or all re-raise its exception). Retains nothing past
    the in-flight window, so it adds zero staleness — the same contract the
    dual-peak guard relies on to honour "today is never cached".

    This is the plain single-flight the cheap per-day ``/api/range`` slice
    queries (ratio/fill/depth/poc/vdist/broker_late/continuous) use to collapse
    the concurrent-overlap duplication of a cumulative deep-scroll burst: nested
    ``[from, today]`` ranges share days, so each day's parquet compute runs once
    and the losers re-read the now-warm ``PastIndicatorsCache``. Unlike
    ``PeakSliceGuard`` it deliberately adds NO semaphore — these are ordinary
    GROUP-BY reads, not the ~17GB dual-peak, so capping them would needlessly
    serialize legitimate wide-range first-touch work.
    """

    def __init__(self) -> None:
        self._inflight_lock = threading.Lock()
        self._inflight: dict[Hashable, _Flight] = {}

    def run(self, key: Hashable, compute: Callable[[], T]) -> T:
        with self._inflight_lock:
            flight = self._inflight.get(key)
            leader = flight is None
            if leader:
                flight = _Flight()
                self._inflight[key] = flight

        assert flight is not None
        if not leader:
            flight.done.wait()
            if flight.error is not None:
                raise flight.error
            return flight.result  # type: ignore[return-value]

        try:
            result = self._run_leader(compute)
            flight.result = result
            return result
        except BaseException as exc:  # noqa: BLE001 - re-raised to followers + caller
            flight.error = exc
            raise
        finally:
            with self._inflight_lock:
                self._inflight.pop(key, None)
            flight.done.set()

    def _run_leader(self, compute: Callable[[], T]) -> T:
        """Leader-only execution hook. Base = run ``compute`` directly;
        ``PeakSliceGuard`` overrides to wrap it in its concurrency semaphore."""
        return compute()


class PeakSliceGuard(SliceCoalescer):
    """``SliceCoalescer`` plus a process-wide concurrency cap for the heavy dual
    ask/bid peak query (see module docstring — load-bearing OOM mitigation).

    A module-level default instance is used in production; tests construct their
    own with an explicit ``concurrency`` for deterministic assertions.
    """

    def __init__(self, concurrency: int | None = None) -> None:
        super().__init__()
        self._sem = threading.BoundedSemaphore(
            concurrency
            if concurrency is not None
            else _resolve_concurrency("HOGA_PEAK_QUERY_CONCURRENCY", DEFAULT_CONCURRENCY)
        )

    def _run_leader(self, compute: Callable[[], T]) -> T:
        with self._sem:
            return compute()


# Process-wide default guard for the dual ask/bid peak query.
GUARD = PeakSliceGuard()

# Process-wide single-flight for the cheap per-day slice queries (ratio, fill,
# depth, poc, vdist, broker_late, continuous, single-peak fallback). Collapses
# the concurrent overlapping-day duplication of a cumulative deep-scroll burst.
SLICE_COALESCER = SliceCoalescer()
