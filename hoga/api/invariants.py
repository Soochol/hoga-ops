"""Data integrity invariants catalog (ADR-0020).

A single registry of declarative rules that all four checkpoints share:
  - hoga/parser/__init__.py    (write-time archival)
  - hoga/api/disk_state.py     (classify_from_meta)
  - hoga/api/bundle.py         (read-path skip + surfacing)
  - hoga/cli.py                (validate sweep)

See docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md §4.
"""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum


class Severity(str, Enum):
    error = "error"
    warn = "warn"


@dataclass(frozen=True)
class Violation:
    invariant_id: str
    severity: Severity
    message: str
    ctx: dict

    def as_dict(self) -> dict:
        return {
            "invariant_id": self.invariant_id,
            "severity": self.severity.value,
            "message": self.message,
            "ctx": self.ctx,
        }


@dataclass(frozen=True)
class Invariant:
    id: str
    severity: Severity
    description: str
    check: Callable[[dict], Violation | None]


# --- error: data shape itself is broken ---
# HHMMSSmmm encoding (HH*10_000_000 + MM*100_000 + SS*1000 + ms):
#   04:00 = 40_000_000, 12:00 = 120_000_000, 18:00 = 180_000_000.
# Production session_open_ms / close_ms use this encoding —
# cross-reference hoga/api/disk_state.py:_SESSION_OPEN_MS = HogaMs(90000000)  # 09:00:00.000.

def _meta_close_after_open(m: dict) -> Violation | None:
    open_ms = m.get("regular_session_open_ms", 0)
    close_ms = m.get("regular_session_close_ms", 0)
    if close_ms > open_ms:
        return None
    return Violation(
        "meta.close_after_open",
        Severity.error,
        "session close must be strictly greater than open",
        {"open_ms": open_ms, "close_ms": close_ms},
    )


def _meta_open_in_kst_range(m: dict) -> Violation | None:
    open_ms = m.get("regular_session_open_ms", 0)
    if 40_000_000 <= open_ms <= 120_000_000:
        return None
    return Violation(
        "meta.open_in_kst_range",
        Severity.error,
        "session open outside plausible KRX morning window (04:00–12:00 KST)",
        {"open_ms": open_ms},
    )


def _meta_close_in_kst_range(m: dict) -> Violation | None:
    close_ms = m.get("regular_session_close_ms", 0)
    if 120_000_000 <= close_ms <= 180_000_000:
        return None
    return Violation(
        "meta.close_in_kst_range",
        Severity.error,
        "session close outside plausible KRX afternoon window (12:00–18:00 KST)",
        {"close_ms": close_ms},
    )


# --- warn: shape plausible, trust low ---

def _collection_finished(m: dict) -> Violation | None:
    if m.get("collection_complete", False):
        return None
    return Violation(
        "collection.finished",
        Severity.warn,
        "capture aborted before completion (likely partial data)",
        {"complete": m.get("collection_complete", False)},
    )


def _collection_unique_events_ratio(m: dict) -> Violation | None:
    pages = m.get("pages_collected", 0)
    if pages == 0:
        return None
    events = m.get("total_unique_events", 0)
    threshold = max(10, pages // 2)
    if events >= threshold:
        return None
    return Violation(
        "collection.unique_events_ratio",
        Severity.warn,
        "low unique-event-per-page ratio (possible upstream stagnation)",
        {"pages": pages, "events": events},
    )


INVARIANTS: tuple[Invariant, ...] = (
    Invariant(
        id="meta.close_after_open",
        severity=Severity.error,
        description="regular_session_close_ms must be strictly greater than open_ms",
        check=_meta_close_after_open,
    ),
    Invariant(
        id="meta.open_in_kst_range",
        severity=Severity.error,
        description="open_ms within 04:00-12:00 KST (HHMMSSmmm encoding)",
        check=_meta_open_in_kst_range,
    ),
    Invariant(
        id="meta.close_in_kst_range",
        severity=Severity.error,
        description="close_ms within 12:00-18:00 KST (HHMMSSmmm encoding)",
        check=_meta_close_in_kst_range,
    ),
    Invariant(
        id="collection.finished",
        severity=Severity.warn,
        description="collection_complete bit must be True",
        check=_collection_finished,
    ),
    Invariant(
        id="collection.unique_events_ratio",
        severity=Severity.warn,
        description="≥50% of pages must yield at least one new event (stagnation suspicion)",
        check=_collection_unique_events_ratio,
    ),
)


def check(meta: dict) -> list[Violation]:
    """Run every invariant against ``meta``. Returns the violations list
    (empty when ``meta`` is integral). Order matches ``INVARIANTS`` declaration
    order — callers that care about presentation order should not re-sort.
    """
    return [v for inv in INVARIANTS if (v := inv.check(meta)) is not None]
