"""Classifies a (code, date) Stock-Date directory into one of four completeness states.

Shared by the parser (writes the two completeness bits into meta.json), the
worker `deciding` phase (decides skip/resume/fresh — Plan B), the calendar
endpoint (cell markers — Plan B), and `queries.list_stock_dates` (surfaces
the bits on the wire). See ADR-0007 for why this lives in its own module.
"""

from __future__ import annotations

import json
from collections.abc import Iterable
from enum import Enum
from pathlib import Path

from hoga.api.timeenc import HogaMs


class DiskState(Enum):
    NONE = "none"
    CLIENT_INCOMPLETE = "client_incomplete"
    SOURCE_PARTIAL = "source_partial"
    COMPLETE = "complete"


def check_disk_state(data_dir: Path, code: str, date: str) -> DiskState:
    """Classify the on-disk state for (code, date) under ``data_dir``.

    Resolution order:
      1. ``data/parquet/{date}/{code}/meta.json`` exists → COMPLETE or SOURCE_PARTIAL
         (depending on meta["collection_complete"] and meta["is_partial"]).
         Falls through to CLIENT_INCOMPLETE if meta says the capture was
         interrupted (collection_complete=False) — this matches the case
         where parse ran on partial raw and we want to resume.
      2. ``data/raw/{date}/{code}/`` has any TSV files → CLIENT_INCOMPLETE.
      3. Otherwise → NONE.
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
            return DiskState.CLIENT_INCOMPLETE
        # Legacy meta (pre-foundation) lacks both fields. Conservative default
        # is "client incomplete" so a subsequent capture run will upgrade it.
        collection_complete = bool(meta.get("collection_complete", False))
        is_partial = bool(meta.get("is_partial", True))
        if not collection_complete:
            return DiskState.CLIENT_INCOMPLETE
        return DiskState.SOURCE_PARTIAL if is_partial else DiskState.COMPLETE

    raw_dir = data_dir / "raw" / date / code
    if raw_dir.exists() and any(raw_dir.glob("first_*.tsv")):
        return DiskState.CLIENT_INCOMPLETE

    return DiskState.NONE


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
