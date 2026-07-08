"""Reusable cache building blocks for the /live "past = immutable, today =
TTL" dual-horizon pattern.

That pattern is hand-rolled in four caches today (minute/daily candles, past
indicators, index candles). This module extracts the two clean halves so a
domain cache becomes a thin facade composing them:

- ``LruDict``          — a bounded OrderedDict that reports evictions to CacheStats.
- ``TtlTriStateCache`` — the today horizon: (fetched_at, value) with TTL + LRU and
                          a tri-state accessor (hit / miss / negative).
- ``DualHorizonCache`` — a holder pairing a past store (``PastStoreLike``) with a
                          today ``TtlTriStateCache``.

Deliberately NOT built here (see ADR-0092): the 2-tier code-locality LRU
(``PastCandlesCache``) and the disk read-through store (``PastIndicatorsCache``).
The ``PastStoreLike`` protocol is the seam those will slot into later; for now the
only past-store implementation is ``LruDict``.
"""
from __future__ import annotations

import time
from collections import OrderedDict
from collections.abc import Callable
from typing import Generic, Literal, Protocol, TypeVar

from hoga.util.cache_stats import CacheStats

K = TypeVar("K")
V = TypeVar("V")
TriState = Literal["hit", "miss", "negative"]


def _monotonic() -> float:
    # Late attribute lookup (not a captured bound method) so a test patching the
    # time module's monotonic is observed. Domain caches that want the patch to
    # resolve through *their* module namespace pass their own late-lookup clock.
    return time.monotonic()


class LruDict(Generic[K, V]):
    """Bounded, insertion-ordered map with LRU eviction from the oldest end.

    ``max_entries`` is clamped to >= 0 (0 evicts on the next ``trim``). Eviction
    is not automatic on insert — call ``trim()`` after mutating — mirroring the
    hand-rolled ``_trim_lru`` the domain caches used, so migration is behaviour-
    preserving. Each eviction bumps ``stats`` if provided.
    """

    def __init__(self, max_entries: int, *, stats: CacheStats | None = None) -> None:
        self._max = max(0, int(max_entries))
        self._d: OrderedDict[K, V] = OrderedDict()
        self._stats = stats

    def get(self, key: K, default: V | None = None) -> V | None:
        return self._d.get(key, default)

    def setdefault(self, key: K, factory: Callable[[], V]) -> V:
        existing = self._d.get(key)
        if existing is not None or key in self._d:
            return self._d[key]
        value = factory()
        self._d[key] = value
        return value

    def move_to_end(self, key: K) -> None:
        if key in self._d:
            self._d.move_to_end(key)

    def trim(self) -> None:
        while len(self._d) > self._max:
            self._d.popitem(last=False)
            if self._stats is not None:
                self._stats.record_eviction()

    def pop(self, key: K, default: V | None = None) -> V | None:
        return self._d.pop(key, default)

    def __contains__(self, key: object) -> bool:
        return key in self._d

    def __len__(self) -> int:
        return len(self._d)


class TtlTriStateCache(Generic[K, V]):
    """Today horizon: ``(fetched_at, value)`` with TTL expiry, LRU cap, and a
    tri-state accessor. A stored ``None`` is a valid "negative" result (fetched,
    no data — e.g. a non-trading day), distinct from a miss.

    Expiry boundary is ``elapsed >= ttl`` (inclusive), matching the hand-rolled
    caches. ``clock`` defaults to a late ``time.monotonic()`` lookup so patching
    the time module is observed; pass a module-local ``lambda: time.monotonic()``
    if a test patches through a specific module's namespace.
    """

    def __init__(
        self,
        ttl_seconds: float,
        max_entries: int,
        *,
        clock: Callable[[], float] = _monotonic,
        stats: CacheStats | None = None,
    ) -> None:
        self._ttl = ttl_seconds
        self._max = max(0, int(max_entries))
        self._clock = clock
        self._stats = stats
        self._d: OrderedDict[K, tuple[float, V | None]] = OrderedDict()

    def get(self, key: K) -> tuple[TriState, V | None]:
        entry = self._d.get(key)
        if entry is None:
            if self._stats is not None:
                self._stats.record_miss()
            return "miss", None
        fetched_at, value = entry
        if self._clock() - fetched_at >= self._ttl:
            self._d.pop(key, None)
            if self._stats is not None:
                self._stats.record_miss()
            return "miss", None
        self._d.move_to_end(key)
        if value is None:
            if self._stats is not None:
                self._stats.record_negative()
            return "negative", None
        if self._stats is not None:
            self._stats.record_hit()
        return "hit", value

    def store(self, key: K, value: V | None) -> None:
        self._d[key] = (self._clock(), value)
        self._d.move_to_end(key)
        if self._stats is not None:
            self._stats.record_store()
        while len(self._d) > self._max:
            self._d.popitem(last=False)
            if self._stats is not None:
                self._stats.record_eviction()

    def __contains__(self, key: object) -> bool:
        # Raw presence (TTL-agnostic) — mirrors the hand-rolled `in _today_mem`
        # checks that verify LRU eviction, not expiry.
        return key in self._d

    def __len__(self) -> int:
        return len(self._d)


class PastStoreLike(Protocol):
    """The past-horizon slot of ``DualHorizonCache``. ``LruDict`` satisfies it
    today; a 2-tier LRU or a disk read-through store can satisfy it later
    without changing the holder (ADR-0092)."""

    def __contains__(self, key: object) -> bool: ...
    def __len__(self) -> int: ...


P = TypeVar("P", bound=PastStoreLike)
T = TypeVar("T")


class DualHorizonCache(Generic[P, T]):
    """Pairs an immutable past store with a TTL today store. A domain cache
    composes its public API over ``.past`` and ``.today`` rather than
    re-implementing horizon bookkeeping."""

    def __init__(self, *, past: P, today: TtlTriStateCache[object, T]) -> None:
        self.past = past
        self.today = today
