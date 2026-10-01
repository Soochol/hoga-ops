"""Compact retained books; delivery and API boundaries still expose ordinary dicts.

Only the known price/quantity ladders and atomic metadata are packed. Unknown
container fields fall back intact, so adding a payload field cannot discard it.
Built-in tuples become untracked after GC; tuple subclasses would remain tracked.
"""
from __future__ import annotations

StoredBook = dict | tuple[int, tuple[tuple[str, object], ...]]

_ATOMIC_TYPES = (str, int, float, bool, type(None))
_SIDES = ("asks", "bids")
_LEVEL_FIELD_COUNT = 2


def pack_book(entry: dict) -> StoredBook:
    """Retain independent scalar ladders without keeping twenty level dicts alive."""
    if type(entry.get("t_ms")) is not int:
        return entry
    fields: list[tuple[str, object]] = []
    for key, value in entry.items():
        if key in _SIDES:
            if not isinstance(value, list):
                return entry
            levels: list[object] = []
            for level in value:
                if (not isinstance(level, dict) or len(level) != _LEVEL_FIELD_COUNT
                        or "price" not in level or "qty" not in level
                        or type(level["price"]) not in _ATOMIC_TYPES
                        or type(level["qty"]) not in _ATOMIC_TYPES):
                    return entry
                levels.extend((level["price"], level["qty"]))
            fields.append((key, tuple(levels)))
        elif type(value) in _ATOMIC_TYPES:
            fields.append((key, value))
        else:
            return entry
    return entry["t_ms"], tuple(fields)


def book_time(entry: StoredBook) -> int:
    return entry["t_ms"] if isinstance(entry, dict) else entry[0]


def unpack_book(entry: StoredBook) -> dict:
    """Materialize only at a read boundary; preserve missing and optional keys."""
    if isinstance(entry, dict):
        return dict(entry)
    out = dict(entry[1])
    for side in _SIDES:
        if side in out:
            values = out[side]
            out[side] = [
                {"price": values[i], "qty": values[i + 1]}
                for i in range(0, len(values), 2)
            ]
    return out
