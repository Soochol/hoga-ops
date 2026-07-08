"""Lightweight hit/miss/eviction counters for cache observability.

One ``CacheStats`` tracks a single cache *surface*. A cache with more than one
surface (past vs today horizon, or per-kind indicator stores) owns one
``CacheStats`` each and composes their ``snapshot()`` dicts under named keys —
the same shape ``KisCapacityScheduler.snapshot()`` returns for the live status
endpoint.

Counters are bare ``+= 1`` with no lock. That mirrors the existing unlocked
counters on ``KisCapacityScheduler`` and the unlocked ``OrderedDict`` mutation in
the caches these instrument: in CPython the increment is a single bytecode step,
and observability tolerates an occasional lost increment under contention. The
one cache genuinely touched from multiple threads (``TodayTtlCache``) increments
inside its own existing lock, so even that case is covered.

Two-tier caches (an in-memory LRU over a disk store) split their hits:
``record_disk_hit`` bumps both ``hits`` and ``disk_hits``. Then
``disk_hits / hits`` reveals memory-LRU churn (the value existed but had been
evicted from memory), while ``hits / lookups`` reveals overall availability.
Memory-only caches never call it, so ``disk_hits`` stays 0 — truthful, not
misleading.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class CacheStats:
    """Monotonic counters for one cache surface.

    ``negatives`` counts tri-state "cached absence" lookups (a completed fetch
    that found no data, e.g. a non-trading day) — a cache serve, but not a serve
    of real data, so it is a lookup but not a hit.
    """

    hits: int = 0
    disk_hits: int = 0
    misses: int = 0
    negatives: int = 0
    stores: int = 0
    evictions: int = 0

    def record_hit(self) -> None:
        self.hits += 1

    def record_disk_hit(self) -> None:
        self.hits += 1
        self.disk_hits += 1

    def record_miss(self) -> None:
        self.misses += 1

    def record_negative(self) -> None:
        self.negatives += 1

    def record_store(self) -> None:
        self.stores += 1

    def record_eviction(self, n: int = 1) -> None:
        if n > 0:
            self.evictions += n

    @property
    def lookups(self) -> int:
        return self.hits + self.misses + self.negatives

    def snapshot(self, *, size: int | None = None) -> dict[str, int | float | None]:
        lookups = self.lookups
        return {
            "hits": self.hits,
            "disk_hits": self.disk_hits,
            "misses": self.misses,
            "negatives": self.negatives,
            "stores": self.stores,
            "evictions": self.evictions,
            "lookups": lookups,
            "hit_rate": round(self.hits / lookups, 4) if lookups else None,
            "size": size,
        }
