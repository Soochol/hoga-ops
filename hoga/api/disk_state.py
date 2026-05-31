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
    NO_UPSTREAM_DATA = "no_upstream_data"   # ADR-0021
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


def latest_complete_date(data_dir: Path, code: str) -> str | None:
    """Return the latest YYYYMMDD Stock-Date for ``code`` whose parquet
    artifact is COMPLETE on disk, or ``None`` if no Stock-Date for the
    code has reached the COMPLETE state.

    Walks ``<data_dir>/parquet/<YYYYMMDD>/<code>/`` — the canonical
    layout — and consults :func:`check_disk_state` for each candidate.
    O(date_dirs) stat calls; for a typical user (<300 captured dates
    total across all symbols) this is sub-millisecond.

    Backs Watchlist's disk-reconcile flow: ``add_entry`` seeds
    ``last_success_date`` from this helper when registering a Code, and
    ``_catchup_run`` advances stale markers to match the disk on every
    server start. Source-of-truth: COMPLETE only (SOURCE_PARTIAL and
    CLIENT_INCOMPLETE are in-flight from the user's POV).
    """
    parquet_root = data_dir / "parquet"
    if not parquet_root.exists():
        return None
    latest: str | None = None
    for date_dir in parquet_root.iterdir():
        if not date_dir.is_dir():
            continue
        date = date_dir.name
        # Cheap pre-check before the more expensive disk_state inspection.
        if not (date_dir / code).is_dir():
            continue
        if check_disk_state(data_dir, code, date).state != DiskState.COMPLETE:
            continue
        if latest is None or date > latest:
            latest = date
    return latest


def check_disk_state(data_dir: Path, code: str, date: str) -> Classification:
    """Classify the on-disk state for ``(code, date)`` under ``data_dir``.

    Resolution order (ADR-0021 + ADR-0020 + ADR-0007):
      0. ``raw/{date}/{code}/.no_upstream_data`` sentinel exists →
         ``NO_UPSTREAM_DATA``. Sentinel-first ordering protects against
         stale parquet artifacts left from a prior capture; by invariant
         (ADR-0021) the sentinel sits alone, but the ordering makes the
         contract robust to bugs that violate it.
      1. ``data/parquet/{date}/{code}/meta.json`` exists → delegate to
         :func:`classify_from_meta`. Truncated / unreadable JSON →
         ``CLIENT_INCOMPLETE`` (no violations).
      2. ``data/raw/{date}/{code}/`` has any TSV files → ``CLIENT_INCOMPLETE``.
      3. Otherwise → ``NONE``.
    """
    raw_dir = data_dir / "raw" / date / code
    if (raw_dir / ".no_upstream_data").exists():
        return Classification(state=DiskState.NO_UPSTREAM_DATA)

    parquet_dir = data_dir / "parquet" / date / code
    # Source-aware lookup (ADR-0037): prefer per-source meta.json under
    # parquet/{date}/{code}/{source}/meta.json. We aggregate across sources
    # via the same priority used by aggregate_disk_state.
    per_source = classify_stock_date(parquet_dir)
    if per_source:
        aggregated = aggregate_disk_state({src: c.state for src, c in per_source.items()})
        # classify_stock_date already parsed every source's meta and kept the
        # violations, so surface the winning source's Classification directly —
        # no second meta.json read (be-capture-03).
        winning = next(
            (per_source[src] for src in ("hogaplay", "kis_live")
             if src in per_source and per_source[src].state == aggregated),
            None,
        )
        return winning if winning is not None else Classification(state=aggregated)

    # Legacy flat-layout fallback (pre-migration / never-migrated test fixtures).
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

    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return Classification(state=DiskState.CLIENT_INCOMPLETE)

    return Classification(state=DiskState.NONE)


# ============================================================================
# Stage 6A — Source-aware helpers (ADR-0037)
# ============================================================================


def classify_stock_date(stock_date_dir: Path) -> dict[str, Classification]:
    """Return per-source :class:`Classification` for a Stock-Date directory.

    Walks `<stock_date_dir>/*/meta.json` — each immediate subdirectory is a
    Source (e.g. `hogaplay`, `kis_live` per ADR-0037). Subdirs without a
    `meta.json` are skipped. Invalid JSON yields ``Classification(INVALID)``
    (no violations — the JSON didn't parse) for that source.

    Carries the full Classification (state + violations) rather than just the
    state, so :func:`check_disk_state` can surface the winning source's
    violations without reading its meta.json a second time. Aggregation callers
    project to state via ``{src: c.state for src, c in result.items()}``;
    key-only callers (``sources.resolve_source``) are unaffected.

    Returns empty dict if `stock_date_dir` doesn't exist or has no source
    subdirs.
    """
    out: dict[str, Classification] = {}
    if not stock_date_dir.is_dir():
        return out
    for src_dir in stock_date_dir.iterdir():
        if not src_dir.is_dir():
            continue
        meta_path = src_dir / "meta.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (ValueError, OSError):
            out[src_dir.name] = Classification(state=DiskState.INVALID)
            continue
        out[src_dir.name] = classify_from_meta(meta)
    return out


# Severity ordering for cross-source aggregation. COMPLETE wins so a single
# COMPLETE source promotes the Stock-Date to COMPLETE even if other sources
# are missing or partial — see Pre-Stage A in the live capture plan.
_AGGREGATE_PRIORITY = (
    DiskState.COMPLETE,
    DiskState.SOURCE_PARTIAL,
    DiskState.CLIENT_INCOMPLETE,
    DiskState.NO_UPSTREAM_DATA,
    DiskState.INVALID,
    DiskState.NONE,
)


def aggregate_disk_state(per_source: dict[str, DiskState]) -> DiskState:
    """Pick the best DiskState across sources.

    Priority: COMPLETE > SOURCE_PARTIAL > CLIENT_INCOMPLETE > NO_UPSTREAM_DATA
    > INVALID > NONE. A single COMPLETE source wins even if others are
    INVALID — the user can still render that Stock-Date via Source Preference
    fallback (ADR-0039).

    Empty input → NONE.
    """
    if not per_source:
        return DiskState.NONE
    states = set(per_source.values())
    for p in _AGGREGATE_PRIORITY:
        if p in states:
            return p
    return DiskState.NONE


_SESSION_OPEN_MS: HogaMs = HogaMs(90000000)        # 09:00:00.000
_GAP_THRESHOLD_MS = 60_000                         # 1 minute (a duration, not a HogaMs)
_MIN_DATAPOINTS_FOR_GAP_ANALYSIS = 2               # need ≥2 to compute consecutive deltas
_AUCTION_WINDOW_DURATION_MS = 10 * 60 * 1000       # closing Auction Window: last 10 min of Regular Session


def _hhmmssms_to_intra_ms(t: HogaMs) -> int:
    """Decode HHMMSSmmm packed-decimal to linear ms-from-midnight.

    Mirrors the SQL helper ``hhmmssms_to_intra_ms_sql`` (timeenc.py). HogaMs
    arithmetic is NON-LINEAR — subtracting two raw values across a minute
    boundary inflates the apparent gap by ~40s, across an hour boundary by
    ~40min. This decode MUST happen before any duration math.
    """
    h = t // 10_000_000
    m = (t // 100_000) % 100
    s = (t // 1000) % 100
    ms = t % 1000
    return (h * 3600 + m * 60 + s) * 1000 + ms


def has_meaningful_gaps(
    ts_ms_values: Iterable[HogaMs],
    *,
    session_close_ms: HogaMs,
) -> bool:
    """True if any consecutive pair within continuous-trading hours has a gap
    ≥ 1 minute. Pure function — no I/O.

    Operates on linear ms-from-midnight: HogaMs subtraction is unsafe across
    minute/hour boundaries (timeenc.py:54). The dominant prod false-positive
    before this fix was hour-boundary inflation (every multi-hour stream
    classified SOURCE_PARTIAL regardless of real density).

    The analysis window is ``[09:00, session_close - 10min)`` — i.e. continuous
    trading only. Snapshots inside the closing Auction Window (last 10 min of
    the Regular Session) are excluded: no continuous matching happens there,
    so absence of snapshot churn is normal market behavior, not a data gap.
    ``session_close_ms`` is per-Stock-Date (Half-Day-safe: a 12:30 close
    correctly bounds the analysis at 12:20).

    Args:
      ts_ms_values: snapshot timestamps as HogaMs (HHMMSSmmm encoding).
        Pre-session, Auction-Window, and post-close events are filtered out
        before gap analysis, so passing the full snapshot stream is safe.
      session_close_ms: this Stock-Date's ``regular_session_close_ms`` from
        meta (HogaMs / HHMMSSmmm). Required: a hardcoded default would re-
        introduce the Half-Day footgun.

    Returns:
      True if a gap is detected OR input has fewer than 2 in-session datapoints
      (too sparse to prove completeness — conservative default).
    """
    open_linear = _hhmmssms_to_intra_ms(_SESSION_OPEN_MS)
    auction_start_linear = _hhmmssms_to_intra_ms(session_close_ms) - _AUCTION_WINDOW_DURATION_MS
    in_session = sorted(
        intra for t in ts_ms_values
        if open_linear <= (intra := _hhmmssms_to_intra_ms(t)) < auction_start_linear
    )
    if len(in_session) < _MIN_DATAPOINTS_FOR_GAP_ANALYSIS:
        return True
    # strict=False is correct: in_session[1:] is intentionally one shorter
    # (we're walking consecutive pairs, last element has no successor).
    return any(
        curr - prev >= _GAP_THRESHOLD_MS
        for prev, curr in zip(in_session, in_session[1:], strict=False)
    )
