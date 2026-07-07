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


def _resolve_concurrency() -> int:
    raw = os.environ.get("HOGA_PEAK_QUERY_CONCURRENCY")
    if raw is None:
        return DEFAULT_CONCURRENCY
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_CONCURRENCY


class _Flight(Generic[T]):
    __slots__ = ("done", "result", "error")

    def __init__(self) -> None:
        self.done = threading.Event()
        self.result: T | None = None
        self.error: BaseException | None = None


class PeakSliceGuard:
    """Semaphore + single-flight around a heavy compute keyed by a hashable.

    A module-level default instance is used in production; tests construct their
    own with an explicit ``concurrency`` for deterministic assertions.
    """

    def __init__(self, concurrency: int | None = None) -> None:
        self._sem = threading.BoundedSemaphore(
            concurrency if concurrency is not None else _resolve_concurrency()
        )
        self._inflight_lock = threading.Lock()
        self._inflight: dict[Hashable, _Flight] = {}

    def run(self, key: Hashable, compute: Callable[[], T]) -> T:
        """Run ``compute`` under the guard.

        Concurrent callers sharing ``key`` execute ``compute`` exactly once and
        all receive that result (or all re-raise its exception). The number of
        distinct keys computing at any instant is capped by the semaphore.
        """
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
            with self._sem:
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


# Process-wide default guard for the dual ask/bid peak query.
GUARD = PeakSliceGuard()
