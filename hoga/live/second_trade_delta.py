"""Bounded response revisions. Old buckets are replaced, never added twice."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import dataclass
from threading import RLock
from uuid import uuid4

from hoga.api.models import SecondAggregatesResponse, SecondBarModel, SecondPriceModel

from .second_trade_agg import aggregate_bars


@dataclass
class _RawSnapshot:
    scope: tuple
    signatures: dict[int, tuple]
    metadata: SecondAggregatesResponse
    bars: dict[int, SecondBarModel]
    prices: dict[int, list[SecondPriceModel]]


def _signature(row: dict, include_prices: bool) -> tuple:
    # Defensive immutable snapshot: file replacement can change values without
    # increasing a revision, and callers may mutate nested price lists.
    return (row["t_ms"], row["open"], row["high"], row["low"], row["close"],
            row["volume"], row["trade_value"], row["count"], tuple(row["first"]), tuple(row["last"]),
            tuple(map(tuple, row["prices"])) if include_prices else ())


class SecondResponseRevisions:
    def __init__(self, limit: int = 8) -> None:
        self.limit = limit
        self._snapshots: OrderedDict[str, tuple[tuple, SecondAggregatesResponse]] = OrderedDict()
        self._raw_snapshots: OrderedDict[str, _RawSnapshot] = OrderedDict()
        self._lock = RLock()

    def project_rows(self, scope: tuple, merged: dict, source: str | None,
                     storage_error: str | None, since: str | None) -> SecondAggregatesResponse:
        """Compare raw seconds first; aggregate/model only changed buckets.

        A cheap day scan still validates corrections and observed coverage.
        Full resets retain the same contract as a non-incremental request.
        """
        code, venue, date, seconds, start, end, include_prices, regular_only, day_start = scope
        open_ms, close_ms = day_start + 9 * 3_600_000, day_start + 930 * 60_000
        selected = {t: row for t, row in merged.items() if not regular_only or open_ms <= t <= close_ms}
        rows = {t: row for t, row in selected.items() if start <= t < end}
        signatures = {t: _signature(row, include_prices) for t, row in rows.items()}
        metadata = SecondAggregatesResponse(
            code=code, venue=venue, date=date, seconds=seconds,
            status="observed" if rows else "unavailable", coverage="unverified",
            source=source, storage_error=storage_error,
            first_observed_ms=min(row["first"][0] for row in selected.values()) if selected else None,
            last_observed_ms=max(row["last"][0] for row in selected.values()) if selected else None,
            bars=[], prices=[],
        )
        with self._lock:
            prior = self._raw_snapshots.get(since) if since else None
            baseline = prior if prior and prior.scope == scope and prior.metadata.source == source else None
            changed_raw = (signatures.keys() | baseline.signatures.keys()) if baseline else signatures.keys()
            if baseline:
                changed_raw = {t for t in changed_raw if signatures.get(t) != baseline.signatures.get(t)}
            bucket_ms = seconds * 1000
            affected = {t // bucket_ms * bucket_ms for t in changed_raw}
            projected = aggregate_bars([row for t, row in rows.items()
                                        if t // bucket_ms * bucket_ms in affected], bucket_ms) if affected else []
            updates = {row["t_ms"]: SecondBarModel(**{k: row[k] for k in SecondBarModel.model_fields})
                       for row in projected}
            price_updates = {t: [SecondPriceModel(t_ms=t, price=p, side=side, qty=qty, count=count)
                                 for p, side, qty, count in rows[t]["prices"]]
                             for t in changed_raw if include_prices and t in rows}
            changed_bars = {t for t in affected if not baseline or baseline.bars.get(t) != updates.get(t)}
            changed_prices = {t for t in changed_raw
                              if include_prices and (not baseline or baseline.prices.get(t) != price_updates.get(t))}
            changed = changed_bars | changed_prices
            if baseline and not changed and baseline.metadata == metadata:
                baseline.signatures = signatures
                self._raw_snapshots.move_to_end(since)
                return metadata.model_copy(update={"revision": since, "reset": False})
            bars = dict(baseline.bars) if baseline else {}
            prices = dict(baseline.prices) if baseline else {}
            for t in changed_bars:
                if t in updates:
                    bars[t] = updates[t]
                else:
                    bars.pop(t, None)
            for t in changed_prices:
                if t in price_updates:
                    prices[t] = price_updates[t]
                else:
                    prices.pop(t, None)
            token = uuid4().hex
            self._raw_snapshots[token] = _RawSnapshot(scope, signatures, metadata, bars, prices)
            same_scope = [key for key, snap in self._raw_snapshots.items() if snap.scope == scope]
            for key in same_scope[:-2]:
                del self._raw_snapshots[key]
            while len(self._raw_snapshots) > self.limit:
                self._raw_snapshots.popitem(last=False)
            return metadata.model_copy(update={
                "revision": token, "reset": baseline is None,
                "changed_ms": sorted(changed) if baseline else [],
                "bars": [bars[t] for t in sorted(changed if baseline else bars) if t in bars],
                "prices": [p for t in sorted(changed if baseline else prices) for p in prices.get(t, [])],
            })

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
