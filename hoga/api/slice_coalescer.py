"""Per-key single-flight for the `/api/range` per-day slice computes.

Concurrent callers sharing a key execute the compute exactly once and all
receive that result — this collapses the concurrent-overlap duplication of a
cumulative deep-scroll burst: nested ``[from, today]`` ranges share days, so
each day's parquet compute runs once and the losers re-read the now-warm
``PastIndicatorsCache``. Retains nothing past the in-flight window, so it adds
zero staleness and honours the "today is never cached" contract.

History (ADR-0085 → v2): this module used to also house ``PeakSliceGuard`` — a
2-slot ``BoundedSemaphore`` around the dual ask/bid peak query, added when that
query was a non-equi-join SQL peaking at ~17GB RSS / 155s per day (2026-07-05
OOM). Two rewrites later the guard was retired (2026-07-11):

  * ADR-0085 linear sweep cut the query to ~6.4s / +1.0GB per heavy day, but
    the pure-Python sweep was GIL-bound — 12 concurrent computes took 94s wall
    vs 77s sequential, so the semaphore had silently become a throughput
    shaper, not just a memory bound.
  * ADR-0085 v2 columnar sweep (polars data plane, GIL-released) measured
    1.1s / ~450MB transient per heavy day, and 12 concurrent computes finish
    in 7.1s wall (vs 13.2s sequential) — concurrency is now a net win and the
    per-compute memory bound is far below the DuckDB budget, so the cap was
    removed. Single-flight (this class) remains the storm protection.
"""
from __future__ import annotations

import threading
from collections.abc import Callable, Hashable
from typing import Generic, TypeVar

T = TypeVar("T")


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
    receive that result (or all re-raise its exception). Deliberately adds NO
    semaphore: every `/api/range` slice — including the dual-peak since the
    ADR-0085 v2 columnar rewrite — is cheap enough that capping would needlessly
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
            result = compute()
            flight.result = result
            return result
        except BaseException as exc:  # noqa: BLE001 - re-raised to followers + caller
            flight.error = exc
            raise
        finally:
            with self._inflight_lock:
                self._inflight.pop(key, None)
            flight.done.set()


# Process-wide single-flight for every per-day slice query (dual-peak, ratio,
# fill, depth, poc, vdist, broker_late, continuous). Collapses the concurrent
# overlapping-day duplication of a cumulative deep-scroll burst.
SLICE_COALESCER = SliceCoalescer()
