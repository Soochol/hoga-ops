"""TSV row dispatcher for first.tsv rows.

This module owns the tokenizer and (in Task 6, after table modules exist) the
event-type → table-module registry. Tables register themselves via their
``PARSERS`` dict; this module aggregates them.

For Task 1, the registry is empty — only the tokenizer is functional.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

# Skip set: event types known to carry no structured data.
SKIP_EVENT_TYPES: frozenset[int] = frozenset({5})  # Price Tick

# Event-type → parser registry. Task 6 will populate this from table modules.
PARSERS: dict[int, Callable[[list[str]], Any]] = {}


class FieldCountError(ValueError):
    """A row's tab-separated field count doesn't match the expected count for its event_type."""


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
