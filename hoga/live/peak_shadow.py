"""Opt-in sampled full-vs-incremental comparison on real capture state.

Only diagnostics consume the replica. Legacy API/storage results remain the
authority. Weak ownership, admission limits and fail-open diagnostic isolation
prevent the checker from becoming an unbounded second capture system.
"""
from __future__ import annotations

import logging
import os
import time
import weakref
from collections import Counter, deque
from dataclasses import dataclass

from .peak_changes import PeakChanges, PeakReplica, history_points, prepare, wire_roundtrip

log = logging.getLogger(__name__)


@dataclass
class _Entry:
    native: weakref.ReferenceType
    owner: weakref.ReferenceType
    replica: PeakReplica
    code: str
    venue: str
    side: str


class PeakShadow:
    def __init__(self, *, max_sides=16, max_points=100_000, max_side_points=10_000,
                 max_check_ms=25.0, codes: frozenset[str] | None = None):
        self.max_sides = max(1, min(max_sides, 64))
        self.max_points = max(1, min(max_points, 500_000))
        self.max_side_points = max(1, min(max_side_points, self.max_points))
        self.max_check_ms = max_check_ms
        self.codes = codes
        self.entries: dict[tuple, _Entry] = {}
        self.blocked: dict[tuple, tuple[weakref.ReferenceType, weakref.ReferenceType]] = {}
        self.order = deque()
        self.metrics = Counter(dict.fromkeys(("checks", "matched", "mismatches", "errors", "admission_rejected",
                                              "point_budget_rejected", "time_budget_rejected"), 0))
        self.first_failure: dict | None = None
        self.serial = 0
        self.disabled = False

    @classmethod
    def from_env(cls):
        if os.environ.get("HOGA_PEAK_SHADOW", "").lower() not in {"1", "true"}:
            return None
        codes = frozenset(code.strip() for code in os.environ.get("HOGA_PEAK_SHADOW_CODES", "").split(",")
                          if code.strip())
        return cls(codes=codes or None)

    def attach(self, owner, native, *, code, venue, side, date):
        if self.disabled or (self.codes is not None and code not in self.codes):
            return
        key = (id(owner), code, venue, side)
        blocked = self.blocked.get(key)
        if blocked is not None and blocked[1]() is native:
            return
        self.blocked.pop(key, None)
        existing = self.entries.get(key)
        if existing is not None and existing.native() is native:
            return
        self._drop(key)
        self.prune()
        if len(self.entries) >= self.max_sides:
            self.metrics["admission_rejected"] += 1
            return
        self.serial += 1
        native.changes = PeakChanges()
        generation = f"{date}:{self.serial}:{code}:{venue}:{side}"
        self.entries[key] = _Entry(weakref.ref(native), weakref.ref(owner), PeakReplica(generation), code, venue, side)
        self.order.append(key)
        self.metrics["attached"] += 1

    def _drop(self, key):
        entry = self.entries.pop(key, None)
        if entry is not None and (native := entry.native()) is not None:
            native.changes = None
        if key in self.order:
            self.order.remove(key)

    def release(self, owner, codes: set[str] | None = None):
        for key, entry in list(self.entries.items()):
            if entry.owner() is owner and (codes is None or entry.code not in codes):
                self._drop(key)
        for key, (reference, _) in list(self.blocked.items()):
            if reference() is owner and (codes is None or key[1] not in codes):
                self.blocked.pop(key)

    def prune(self):
        for key, entry in list(self.entries.items()):
            if entry.owner() is None or entry.native() is None:
                self._drop(key)
        for key, (owner, native) in list(self.blocked.items()):
            if owner() is None or native() is None:
                self.blocked.pop(key)

    def reconcile(self, owners):
        """Retired streams must not occupy the sample while still being joined."""
        self.prune()
        current = {id(owner) for owner in owners}
        for key in list(self.entries):
            if key[0] not in current:
                self._drop(key)
        for key in list(self.blocked):
            if key[0] not in current:
                self.blocked.pop(key)
        if self.disabled:
            return
        for owner in owners:
            for side, attr in (("ask", "_ask_peak_by_code"), ("bid", "_bid_peak_by_code")):
                for (code, venue), native in getattr(owner, attr, {}).items():
                    if len(self.entries) >= self.max_sides:
                        return
                    self.attach(owner, native, code=code, venue=venue, side=side, date=owner._ask_peak_date)

    def _block(self, key, entry):
        self.blocked[key] = (entry.owner, entry.native)
        self._drop(key)
        if len(self.blocked) >= 64:  # noqa: PLR2004 — bounded rejected-state bookkeeping
            self.metrics["blocked_budget_rejected"] += 1
            self.close()

    def points(self):
        return sum(entry.replica.points() for entry in self.entries.values())

    def _fail(self, entry, reason, fields=()):
        self.metrics[reason] += 1
        if self.first_failure is None:
            self.first_failure = {"code": entry.code, "venue": entry.venue, "side": entry.side,
                                  "reason": reason, "fields": list(fields)[:8]}
        log.error("collector.peak_shadow_failed code=%s venue=%s side=%s reason=%s fields=%s",
                  entry.code, entry.venue, entry.side, reason, list(fields)[:8])
        # A failed comparator must not poison the next capture tick. Retain only
        # counters/first failure, releasing all replica and journal state.
        self.close()

    def close(self):
        self.disabled = True
        for entry in self.entries.values():
            if (native := entry.native()) is not None:
                native.changes = None
        self.entries.clear()
        self.order.clear()
        self.blocked.clear()

    def check_one(self, *, wire=True):
        try:
            self._check_one(wire=wire)
        except Exception:  # Include bookkeeping/budget faults in diagnostic isolation.
            self.metrics["errors"] += 1
            self.close()
            log.exception("collector.peak_shadow_bookkeeping_failed")

    def check_pair(self, owner, code, venue):
        """Strict replay validation after each callback, outside measured ingest."""
        for side in ("ask", "bid"):
            key = (id(owner), code, venue, side)
            if key in self.entries:
                self.order.remove(key)
                self.order.appendleft(key)
                self.check_one()

    def _check_one(self, *, wire=True):
        self.prune()
        if self.disabled or not self.order:
            return
        key = self.order[0]
        self.order.rotate(-1)
        entry = self.entries[key]
        native = entry.native()
        if native is None:
            return
        required = history_points(native)
        total = self.points() - entry.replica.points() + required
        if required > self.max_side_points or total > self.max_points:
            self.metrics["point_budget_rejected"] += 1
            self._block(key, entry)
            return
        began = time.perf_counter()
        try:
            before = time.perf_counter()
            message = prepare(native, base=entry.replica.revision, generation=entry.replica.generation,
                              empty=entry.replica.metadata is None)
            self.metrics["prepare_us"] += (time.perf_counter() - before) * 1_000_000
            if message is not None:
                before = time.perf_counter()
                if wire:
                    message, size, parts = wire_roundtrip(message)
                    self.metrics["wire_bytes"] += size
                    self.metrics["wire_parts"] += parts
                entry.replica.apply(message)
                native.changes.clear()
                self.metrics["apply_wire_us"] += (time.perf_counter() - before) * 1_000_000
                self.metrics["full" if message["full"] else "delta"] += 1
            before = time.perf_counter()
            reference = native.snapshot()
            candidate = entry.replica.snapshot()
            self.metrics["reference_us"] += (time.perf_counter() - before) * 1_000_000
            self.metrics["checks"] += 1
            if reference != candidate:
                fields = set(reference or {}) | set(candidate or {})
                mismatches = [name for name in fields if (reference or {}).get(name) != (candidate or {}).get(name)]
                self._fail(entry, "mismatches", sorted(mismatches))
            else:
                self.metrics["matched"] += 1
        except Exception:
            self._fail(entry, "errors")
            log.exception("collector.peak_shadow_exception")
        elapsed = (time.perf_counter() - began) * 1000
        self.metrics["check_us"] += elapsed * 1000
        self.metrics["max_check_us"] = max(self.metrics["max_check_us"], elapsed * 1000)
        if not self.disabled and elapsed > self.max_check_ms:
            self.metrics["time_budget_rejected"] += 1
            self._block(key, entry)

    def summary(self):
        self.prune()
        return {"enabled": True, "disabled": self.disabled, "active_sides": len(self.entries),
                "blocked_sides": len(self.blocked),
                "retained_points": self.points(), "first_failure": self.first_failure,
                "sampled": [{"code": entry.code, "venue": entry.venue, "side": entry.side}
                            for entry in self.entries.values()], **dict(self.metrics)}
