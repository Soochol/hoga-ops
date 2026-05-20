"""TSV row dispatcher for first.tsv rows.

Tables register themselves via their ``PARSERS`` dict; this module aggregates
those into a single registry at import time, then dispatches each row to the
right table's parser.

To add a new event type:
1. Add an entry to the table module's ``PARSERS`` and ``EXPECTED_FIELD_COUNTS`` dicts.
2. Import the table module here in ``_TABLES``.
3. No changes to this dispatcher required.

Event types in ``SKIP_EVENT_TYPES`` are accepted but produce ``None`` (no
structured data; e.g. the Price Tick heartbeat).
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, TypeAlias

from hoga.tables import brokers, snapshots, trades
from hoga.tables.brokers import BrokerRow
from hoga.tables.snapshots import Orderbook
from hoga.tables.trades import Trade

# The declared shape of a parsed first.tsv row.
#
# Concretely: type-1/3 → Trade, type-2 → Orderbook, type-4 → list[BrokerRow]
# (one TSV row fans into 10 entities), type-5 (Price Tick) → None.
# Callers should use ``match`` + ``assert_never`` for exhaustive routing.
ParsedRow: TypeAlias = Trade | Orderbook | list[BrokerRow] | None

# Tables that register parsers with the dispatcher. Candles is intentionally
# excluded — it's parsed from chart.tsv, not first.tsv.
_TABLES = (trades, snapshots, brokers)

# Skip set: event types known to carry no structured data.
SKIP_EVENT_TYPES: frozenset[int] = frozenset({5})  # Price Tick


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match the expected count for its event_type."""


PARSERS: dict[int, Callable[[list[str]], Any]] = {}
EXPECTED_FIELD_COUNTS: dict[int, int] = {}
for _table in _TABLES:
    for _et, _parser in _table.PARSERS.items():
        if _et in PARSERS:
            raise RuntimeError(
                f"event type {_et} registered by multiple table modules: "
                f"{_table.__name__} conflicts with an earlier registration"
            )
        PARSERS[_et] = _parser
    for _et, _count in _table.EXPECTED_FIELD_COUNTS.items():
        EXPECTED_FIELD_COUNTS[_et] = _count


def split_row(line: str) -> list[str]:
    """Tokenize a TSV row.

    Strips trailing CR/LF and one trailing empty field (hogaplay rows often
    end with a trailing tab).
    """
    cleaned = line.rstrip("\n").rstrip("\r")
    parts = cleaned.split("\t")
    if parts and parts[-1] == "":
        parts.pop()
    return parts


_MIN_DISPATCH_FIELDS = 2


def parse_row(line: str) -> ParsedRow:
    """Dispatch on field 2 (event_type). Returns the parsed entity, a list of
    entities (broker rows), or None (skip set).

    The return type is the declared union ``ParsedRow``; callers should
    exhaustively match on it.
    """
    parts = split_row(line)
    if len(parts) < _MIN_DISPATCH_FIELDS:
        raise FieldCountError(f"row too short: {len(parts)} fields")
    try:
        event_type = int(parts[1])
    except ValueError as e:
        raise FieldCountError(f"non-numeric event_type: {parts[1]!r}") from e

    if event_type in SKIP_EVENT_TYPES:
        return None
    if event_type not in PARSERS:
        raise ValueError(f"unknown event type {event_type}")
    expected = EXPECTED_FIELD_COUNTS[event_type]
    if len(parts) != expected:
        raise FieldCountError(
            f"event_type={event_type} expects {expected} fields, got {len(parts)}"
        )
    return PARSERS[event_type](parts)
