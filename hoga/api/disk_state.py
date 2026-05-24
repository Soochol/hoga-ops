"""Classifies a (code, date) Stock-Date directory into one of four completeness states.

Shared by the parser (writes the two completeness bits into meta.json), the
worker `deciding` phase (decides skip/resume/fresh — Plan B), the calendar
endpoint (cell markers — Plan B), and `queries.list_stock_dates` (surfaces
the bits on the wire). See ADR-0007 for why this lives in its own module.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path

from hoga.api.invariants import Severity, Violation, check
from hoga.api.timeenc import HogaMs


class DiskState(Enum):
    NONE = "none"
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    INVALID = "invalid"          # ADR-0020: domain invariant violated
    COMPLETE = "complete"


@dataclass(frozen=True)
class Classification:
    """The rich result of evaluating a Stock-Date's meta against the
    invariants catalog. Carries the routing decision (``state``) AND the
    violations that drove it, so callers that surface diagnostics don't
    re-run :func:`hoga.api.invariants.check`.

    Pattern: routing-only callers (eligibility, calendar) read ``.state``;
    surfacing callers (bundle's read-path) read ``.errors`` / ``.warnings``.
    The deletion test fits: removing ``Classification`` would force every
    surfacing caller to re-derive partitions inline — three call sites
    each duplicating the same Severity comparison.
    """
    state: DiskState
    violations: list[Violation] = field(default_factory=list)

    @property
    def errors(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == Severity.error]

    @property
    def warnings(self) -> list[Violation]:
        return [v for v in self.violations if v.severity == Severity.warn]


def classify_from_meta(meta: Mapping[str, object]) -> Classification:
    """Classify a Stock-Date's meta into a routing decision + violations.

    Single source of truth for the meta → ``DiskState`` mapping. Used both by
    :func:`check_disk_state` (which loads meta from disk) and by callers
    that already have the meta dict in memory (e.g., ``queries.list_stock_dates``
    iterating Stock-Date directories) — sharing the helper avoids reading
    meta.json twice per row.

    Priority (ADR-0020):
      1. Any ``error``-severity invariant violation → ``INVALID``. Broken
         data shape (e.g. ``close_ms=0``) is the most serious finding and
         trumps everything: forces eligibility to fresh-capture instead of
         resuming a corrupted parquet, and lets ``build_range_bundle`` skip
         the segment regardless of whether collection completed.
      2. ``collection_complete=False`` → ``CLIENT_INCOMPLETE``. Shape fine
         but capture stopped early — resume from the cursor on next run.
      3. ``warn``-severity violations don't change state (surfaced separately
         via ``Classification.warnings``).
      4. Otherwise fall through to ``is_partial`` → ``SOURCE_PARTIAL`` or
         ``COMPLETE``.

    The 5/18/003490 production case (``collection_complete=False`` AND
    ``close_ms=0``) must reach ``INVALID`` — under the previous
    ``CLIENT_INCOMPLETE``-first ordering it slipped past
    ``build_range_bundle``'s ``INVALID`` filter and re-broke the chart.

    Legacy meta (pre-foundation) lacks both completeness fields. Conservative
    default is ``CLIENT_INCOMPLETE`` so a subsequent capture run will upgrade it.
    """
    violations = check(meta)
    if any(v.severity == Severity.error for v in violations):
        return Classification(state=DiskState.INVALID, violations=violations)

    collection_complete = bool(meta.get("collection_complete", False))
    if not collection_complete:
        return Classification(state=DiskState.CLIENT_INCOMPLETE, violations=violations)

    is_partial = bool(meta.get("is_partial", True))
    state = DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE
    return Classification(state=state, violations=violations)


def check_disk_state(data_dir: Path, code: str, date: str) -> Classification:
    """Classify the on-disk state for ``(code, date)`` under ``data_dir``.

    Returns the same :class:`Classification` shape as :func:`classify_from_meta`,
    with ``violations`` empty for the no-meta paths (NONE / raw-only
    CLIENT_INCOMPLETE) — there's nothing to evaluate.

    Resolution order:
      1. ``data/parquet/{date}/{code}/meta.json`` exists → delegate to
         :func:`classify_from_meta`. Truncated / unreadable JSON →
         ``CLIENT_INCOMPLETE`` (no violations).
      2. ``data/raw/{date}/{code}/`` has any TSV files → ``CLIENT_INCOMPLETE``.
      3. Otherwise → ``NONE``.
    """
    parquet_dir = data_dir / "parquet" / date / code
    meta_path = parquet_dir / "meta.json"
    if meta_path.exists():
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            # Truncated / zero-byte / unreadable meta.json — treat as in-progress
            # so the worker re-captures rather than crashing the calendar / inventory.
            # Matches hoga/parser/__init__.py's pattern for _progress.json reads.
            return Classification(state=DiskState.CLIENT_INCOMPLETE)
        return classify_from_meta(meta)

    raw_dir = data_dir / "raw" / date / code
    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return Classification(state=DiskState.CLIENT_INCOMPLETE)

    return Classification(state=DiskState.NONE)


_SESSION_OPEN_MS: HogaMs = HogaMs(90000000)        # 09:00:00.000
_CHART_FINAL_TIME_MS: HogaMs = HogaMs(153100000)   # 15:31:00.000 — collector terminus
_GAP_THRESHOLD_MS = 60_000                         # 1 minute (a duration, not a HogaMs)
_MIN_DATAPOINTS_FOR_GAP_ANALYSIS = 2               # need ≥2 to compute consecutive deltas


def has_meaningful_gaps(ts_ms_values: Iterable[HogaMs]) -> bool:
    """True if any consecutive pair within continuous-trading hours has a gap
    ≥ 1 minute. Pure function — no I/O.

    Args:
      ts_ms_values: snapshot timestamps as HogaMs (HHMMSSmmm encoding).
        Pre-session and post-close events are filtered out before gap analysis,
        so passing the full snapshot stream is safe and intended. Callers
        responsible for the HogaMs cast — typically a parser-side helper that
        extracts from `Orderbook` entities.

    Returns:
      True if a gap is detected OR input has fewer than 2 in-session datapoints
      (too sparse to prove completeness — conservative default).
    """
    in_session = sorted(
        t for t in ts_ms_values if _SESSION_OPEN_MS <= t <= _CHART_FINAL_TIME_MS
    )
    if len(in_session) < _MIN_DATAPOINTS_FOR_GAP_ANALYSIS:
        return True
    # strict=False is correct: in_session[1:] is intentionally one shorter
    # (we're walking consecutive pairs, last element has no successor).
    return any(
        curr - prev >= _GAP_THRESHOLD_MS
        for prev, curr in zip(in_session, in_session[1:], strict=False)
    )
