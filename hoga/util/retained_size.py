"""Bounded size estimate for one incoming payload, never a process heap scan.

Shared values are counted once within a payload and again across payloads, so
shared-payload accounting errs upward. This is a payload estimate, not RSS:
allocator/bookkeeping and opaque object internals are excluded. Stop at the
caller's budget or node bound; oversized objects need not be walked in full.
"""
from __future__ import annotations

import sys


def retained_size(value: object, *, limit: int, max_nodes: int = 100_000) -> int:
    pending = [value]
    seen: set[int] = set()
    total = 0
    while pending:
        item = pending.pop()
        ident = id(item)
        if ident in seen:
            continue
        seen.add(ident)
        total += sys.getsizeof(item)
        if total > limit or len(seen) >= max_nodes:
            return limit + 1
        if isinstance(item, dict):
            if len(item) > max_nodes - len(seen):
                return limit + 1
            pending.extend(item.keys())
            pending.extend(item.values())
        elif isinstance(item, (tuple, list, set, frozenset)):
            if len(item) > max_nodes - len(seen):
                return limit + 1
            pending.extend(item)
        elif hasattr(item, "__dict__"):
            pending.append(vars(item))
    return total
