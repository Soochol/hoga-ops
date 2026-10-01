"""Bounded response revisions. Old buckets are replaced, never added twice."""
from __future__ import annotations

from collections import OrderedDict
from threading import RLock
from uuid import uuid4

from hoga.api.models import SecondAggregatesResponse


class SecondResponseRevisions:
    def __init__(self, limit: int = 8) -> None:
        self.limit = limit
        self._snapshots: OrderedDict[str, tuple[tuple, SecondAggregatesResponse]] = OrderedDict()
        self._lock = RLock()

    def project(self, scope: tuple, current: SecondAggregatesResponse,
                since: str | None) -> SecondAggregatesResponse:
        with self._lock:
            prior = self._snapshots.get(since) if since else None
            baseline = prior[1] if prior and prior[0] == scope else None
            if baseline == current:
                self._snapshots.move_to_end(since)
                return current.model_copy(update={"revision": since, "reset": False, "bars": [], "prices": []})
            token = uuid4().hex
            self._snapshots[token] = (scope, current)
            # Keep only two versions per query. Lagging/evicted clients safely
            # receive a full reset instead of retaining every day's revision.
            same_scope = [key for key, (key_scope, _) in self._snapshots.items() if key_scope == scope]
            for key in same_scope[:-2]:
                del self._snapshots[key]
            while len(self._snapshots) > self.limit:
                self._snapshots.popitem(last=False)
            if baseline is None or baseline.source != current.source:
                return current.model_copy(update={"revision": token})
            old_bars = {bar.t_ms: bar for bar in baseline.bars}
            new_bars = {bar.t_ms: bar for bar in current.bars}
            changed = {t for t in old_bars.keys() | new_bars.keys() if old_bars.get(t) != new_bars.get(t)}
            old_prices, new_prices = {}, {}
            for price in baseline.prices:
                old_prices.setdefault(price.t_ms, []).append(price)
            for price in current.prices:
                new_prices.setdefault(price.t_ms, []).append(price)
            changed.update(t for t in old_prices.keys() | new_prices.keys()
                           if old_prices.get(t) != new_prices.get(t))
            return current.model_copy(update={
                "revision": token, "reset": False, "changed_ms": sorted(changed),
                "bars": [bar for bar in current.bars if bar.t_ms in changed],
                "prices": [price for price in current.prices if price.t_ms in changed],
            })
