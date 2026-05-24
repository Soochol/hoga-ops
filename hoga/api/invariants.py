"""Data integrity invariants catalog (ADR-0020).

A single registry of declarative rules that all four checkpoints share:
  - hoga/parser/__init__.py    (write-time archival)
  - hoga/api/disk_state.py     (classify_from_meta)
  - hoga/api/bundle.py         (read-path skip + surfacing)
  - hoga/cli.py                (validate sweep)

See docs/superpowers/specs/2026-05-24-data-integrity-checks-design.md §4.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from hoga.api.models import ViolationModel


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

    def to_model(self) -> "ViolationModel":
        """Convert to the Pydantic wire mirror. Keeps the dataclass free
        of Pydantic dep while giving callers a typed wire boundary."""
        from hoga.api.models import ViolationModel
        return ViolationModel(
            invariant_id=self.invariant_id,
            severity=self.severity.value,
            message=self.message,
            ctx=self.ctx,
        )


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

def _meta_close_after_open(m: Mapping[str, Any]) -> Violation | None:
    # Skip when either bound is absent — legacy/partial meta has nothing
    # to compare. Fire only when both are present and the relation is wrong
    # (e.g. upstream stagnation that returned close_ms=0 for a real session).
    if "regular_session_open_ms" not in m or "regular_session_close_ms" not in m:
        return None
    open_ms = m["regular_session_open_ms"]
    close_ms = m["regular_session_close_ms"]
    if close_ms > open_ms:
        return None
    return Violation(
        "meta.close_after_open",
        Severity.error,
        "session close must be strictly greater than open",
        {"open_ms": open_ms, "close_ms": close_ms},
    )


def _meta_open_in_kst_range(m: Mapping[str, Any]) -> Violation | None:
    if "regular_session_open_ms" not in m:
        return None
    open_ms = m["regular_session_open_ms"]
    if 40_000_000 <= open_ms <= 120_000_000:
        return None
    return Violation(
        "meta.open_in_kst_range",
        Severity.error,
        "session open outside plausible KRX morning window (04:00–12:00 KST)",
        {"open_ms": open_ms},
    )


def _meta_close_in_kst_range(m: Mapping[str, Any]) -> Violation | None:
    if "regular_session_close_ms" not in m:
        return None
    close_ms = m["regular_session_close_ms"]
    if 120_000_000 <= close_ms <= 180_000_000:
        return None
    return Violation(
        "meta.close_in_kst_range",
        Severity.error,
        "session close outside plausible KRX afternoon window (12:00–18:00 KST)",
        {"close_ms": close_ms},
    )


# --- warn: shape plausible, trust low ---

def _collection_finished(m: Mapping[str, Any]) -> Violation | None:
    if m.get("collection_complete", False):
        return None
    return Violation(
        "collection.finished",
        Severity.warn,
        "capture aborted before completion (likely partial data)",
        {"complete": m.get("collection_complete", False)},
    )


_MIN_PAGES_FOR_STAGNATION_SIGNAL = 20


def _collection_unique_events_ratio(m: Mapping[str, Any]) -> Violation | None:
    # Stagnation is "many pages, few unique events" — needs enough pages
    # for the ratio to mean anything. Tiny captures (test fixtures, very
    # short trading days, halts) carry no stagnation signal and must skip.
    pages = m.get("pages_collected", 0)
    if pages < _MIN_PAGES_FOR_STAGNATION_SIGNAL:
        return None
    events = m.get("total_unique_events", 0)
    if events >= pages // 2:
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

# Backward-compat alias — ADR-0020 §3c renamed INVARIANTS to META_INVARIANTS
# to make room for the series catalog. External imports of INVARIANTS keep
# working; new code should use META_INVARIANTS for clarity.
META_INVARIANTS: tuple[Invariant, ...] = INVARIANTS


def check(meta: dict) -> list[Violation]:
    """Run every invariant against ``meta``. Returns the violations list
    (empty when ``meta`` is integral). Order matches ``INVARIANTS`` declaration
    order — callers that care about presentation order should not re-sort.
    """
    return [v for inv in INVARIANTS if (v := inv.check(meta)) is not None]


# === Series-level invariants (ADR-0020 §3c) ==============================
# Series invariants run over loaded parquet artifacts, not just meta dict.
# They are evaluated at parser write-time and archived in meta.json's
# invariant_violations field — read-paths do NOT live-evaluate them
# (parquet I/O cost would break per-request SLO). See spec §4.6.


if TYPE_CHECKING:
    # Heavy domain imports only when type-checking; avoids forcing every
    # consumer of hoga.api.invariants to also pull in pyarrow / tables.
    from hoga.tables.candles import Candle
    from hoga.tables.snapshots import Orderbook
    from hoga.tables.trades import Trade


@dataclass(frozen=True)
class StockDateArtifacts:
    """Series-level invariant input. Callers load disk once and pass.

    Fields are Optional so partial loading is supported:
      - parser archival passes all four (already in memory at meta write)
      - hoga validate --deep loads all four from parquet
      - future per-table checks can pass just one
    """
    meta: Mapping[str, Any]
    candles: "list[Candle] | None" = None
    snapshots: "list[Orderbook] | None" = None
    trades: "list[Trade] | None" = None


@dataclass(frozen=True)
class SeriesInvariant:
    """Series invariant returns a list (not a single Violation) so one
    invariant can flag multiple violations across the series (e.g.,
    every cum_vol regression in trades.parquet)."""
    id: str
    severity: Severity
    description: str
    check: Callable[["StockDateArtifacts"], list[Violation]]


# --- error: candles ts_ms strictly ascending ---
# Direct root cause of the 5/18/003490 chart crash. The library's setData
# assertion ("data must be asc ordered by time") fires when this is broken;
# excluding the Stock-Date upstream prevents that path.

def _series_candles_ts_monotonic(a: "StockDateArtifacts") -> list[Violation]:
    if a.candles is None:
        return []
    out: list[Violation] = []
    for i in range(1, len(a.candles)):
        prev = a.candles[i - 1].ts_ms
        curr = a.candles[i].ts_ms
        if curr <= prev:
            out.append(Violation(
                "series.candles_ts_monotonic",
                Severity.error,
                "candles ts_ms must be strictly ascending",
                {"index": i, "prev_ts_ms": prev, "curr_ts_ms": curr},
            ))
    return out


# --- warn: snapshots stream gap ---
# Wraps the existing has_meaningful_gaps predicate so the same signal
# parser uses for is_partial also flows into the catalog.

def _series_snapshots_no_gaps(a: "StockDateArtifacts") -> list[Violation]:
    if a.snapshots is None:
        return []
    close_ms = a.meta.get("regular_session_close_ms")
    if not isinstance(close_ms, int):
        # meta lacks the bound (legacy / malformed) — gap analysis requires it
        # to compute the Auction Window cutoff; skip rather than guess a default.
        return []
    from hoga.api.disk_state import has_meaningful_gaps
    from hoga.api.timeenc import HogaMs
    ts_values = [HogaMs(s.ts_ms) for s in a.snapshots]
    if not has_meaningful_gaps(ts_values, session_close_ms=HogaMs(close_ms)):
        return []
    return [Violation(
        "series.snapshots_no_gaps",
        Severity.warn,
        "snapshot stream has ≥60s gap inside continuous-trading session",
        {"datapoint_count": len(a.snapshots)},
    )]


# --- error: cum_vol non-decreasing across continuous-trade rows ---
# Wraps the trades.find_cum_vol_violations helper (extracted in Task 1)
# so the same scan that parser's strict TradeValidationError uses also
# flows into the catalog — but with one Violation per regression instead
# of first-only.

def _series_cum_vol_monotonic(a: "StockDateArtifacts") -> list[Violation]:
    if a.trades is None:
        return []
    from hoga.tables.trades import find_cum_vol_violations
    out: list[Violation] = []
    for v in find_cum_vol_violations(a.trades):
        out.append(Violation(
            "series.cum_vol_monotonic",
            Severity.error,
            "cum_vol regressed across continuous-trade rows",
            {"index": v.index, "prev_cum": v.prev_cum,
             "curr_cum": v.curr_cum, "ts_ms": v.ts_ms},
        ))
    return out


SERIES_INVARIANTS: tuple[SeriesInvariant, ...] = (
    SeriesInvariant(
        id="series.candles_ts_monotonic",
        severity=Severity.error,
        description="candles ts_ms strictly ascending — chart axis depends on it",
        check=_series_candles_ts_monotonic,
    ),
    SeriesInvariant(
        id="series.snapshots_no_gaps",
        severity=Severity.warn,
        description="no ≥60s gap in continuous-trading snapshot stream",
        check=_series_snapshots_no_gaps,
    ),
    SeriesInvariant(
        id="series.cum_vol_monotonic",
        severity=Severity.error,
        description="cum_vol non-decreasing across continuous-trade rows",
        check=_series_cum_vol_monotonic,
    ),
)


def check_series(artifacts: StockDateArtifacts) -> list[Violation]:
    """Run every series invariant against the loaded artifacts. Returns
    a flat violation list across all invariants. Empty when integral
    (or when ``SERIES_INVARIANTS`` is empty)."""
    out: list[Violation] = []
    for inv in SERIES_INVARIANTS:
        out.extend(inv.check(artifacts))
    return out
