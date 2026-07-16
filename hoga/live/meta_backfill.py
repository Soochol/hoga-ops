"""Backfill completeness fields into already-promoted live meta.json files.

Live promotions written before the completeness change (hoga/live/promote.py's
``_build_meta``) lack ``collection_complete`` / ``is_partial`` / ``gap_ranges``,
so ``classify_from_meta`` freezes them at CLIENT_INCOMPLETE (✕) forever. This
one-shot sweep recomputes those three fields from the on-disk
``snapshots.parquet`` and merges them into each stale meta, so past KIS live/REST
Stock-Dates render honestly on the capture calendar (complete_live / partial_live).

Cold path — allowed to import polars (like promote.py). Not on any hot path.

Only PAST Stock-Dates (``date < today_kst``) are touched: today's stream may
still be live, and the Today Promoter owns finalizing it at 15:35.
"""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import polars as pl

from hoga.api._atomic_write import atomic_write_json
from hoga.api.timeenc import HogaMs
from hoga.live.promote import _completeness_fields

_log = logging.getLogger(__name__)

# Live sources whose meta this sweep repairs. hogaplay is excluded — its parser
# already writes the completeness fields at capture time.
_LIVE_SOURCES: tuple[str, ...] = ("kis_live", "kis_api")
_KST = timezone(timedelta(hours=9))


@dataclass(frozen=True)
class BackfillResult:
    scanned: int = 0   # live meta.json files inspected
    updated: int = 0   # metas that gained completeness fields
    skipped: int = 0   # already finalized (collection_complete=True) or today/future


def _is_yyyymmdd(name: str) -> bool:
    if len(name) != 8 or not name.isdigit():
        return False
    try:
        datetime.strptime(name, "%Y%m%d")
    except ValueError:
        return False
    return True


def _recompute_fields(snapshots_path: Path) -> dict:
    """Recompute the three completeness fields from a snapshots.parquet.

    Delegates the gap analysis + wire shape to ``promote._completeness_fields``
    (the same builder the live promoter uses) so backfill can't drift from it.
    Missing / unreadable parquet → zero in-session snapshots, which the shared
    ``analyze_gaps(anchor_edges=True)`` treats as a full-window gap
    (is_partial=True). ``collection_complete`` is always True here: this sweep
    only runs on past dates, whose streams have ended.
    """
    ts_values: list[HogaMs] = []
    if snapshots_path.exists():
        try:
            df = pl.read_parquet(snapshots_path, columns=["ts_ms"])
            ts_values = [HogaMs(int(v)) for v in df["ts_ms"].to_list()]
        except Exception:  # noqa: BLE001 — corrupt parquet → treat as empty
            _log.warning("meta_backfill.snapshots_unreadable path=%s", snapshots_path)
    return _completeness_fields(ts_values, collection_complete=True)


def backfill_live_meta(
    data_dir: Path, *, dry_run: bool = False, now: datetime | None = None,
) -> BackfillResult:
    """Sweep ``parquet/{date}/{code}/{kis_live,kis_api}/meta.json`` and add the
    completeness fields to any past-date meta that lacks a finalized
    ``collection_complete``. Idempotent: a meta already at
    ``collection_complete=True`` is skipped.
    """
    today = (now or datetime.now(_KST)).strftime("%Y%m%d")
    parquet_root = data_dir / "parquet"
    scanned = updated = skipped = 0
    if not parquet_root.exists():
        return BackfillResult()
    for date_dir in sorted(parquet_root.iterdir()):
        if not date_dir.is_dir() or not _is_yyyymmdd(date_dir.name):
            continue
        if date_dir.name >= today:  # today/future: still-live or midnight-race
            continue
        for code_dir in sorted(date_dir.iterdir()):
            if not code_dir.is_dir():
                continue
            for source in _LIVE_SOURCES:
                meta_path = code_dir / source / "meta.json"
                if not meta_path.exists():
                    continue
                scanned += 1
                try:
                    meta = json.loads(meta_path.read_text(encoding="utf-8"))
                except (ValueError, OSError):
                    # Corrupt/unreadable meta — leave it for a real re-promote
                    # rather than clobbering source/row_counts with a
                    # completeness-only rewrite.
                    _log.warning("meta_backfill.meta_unreadable path=%s", meta_path)
                    skipped += 1
                    continue
                if meta.get("collection_complete") is True:
                    skipped += 1
                    continue
                fields = _recompute_fields(code_dir / source / "snapshots.parquet")
                if dry_run:
                    updated += 1
                    continue
                meta.update(fields)
                atomic_write_json(meta_path, meta, indent=2)
                updated += 1
    return BackfillResult(scanned=scanned, updated=updated, skipped=skipped)
