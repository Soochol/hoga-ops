"""Watchlist display projection.

The Watchlist store owns folder membership. This module owns the display-order
Interface shared by the Watchlist wire model, Live Set planning, and Heatmap
one-time seed.
"""
from __future__ import annotations

import logging

from hoga.api.models import (
    WatchlistDocument,
    WatchlistEntryView,
    WatchlistFolder,
    WatchlistFolderView,
    WatchlistResponse,
)

log = logging.getLogger(__name__)


def ordered_folders(doc: WatchlistDocument) -> list[WatchlistFolder]:
    """Folders in display order."""
    return sorted(doc.folders, key=lambda f: f.order)


def display_ordered_codes(doc: WatchlistDocument) -> list[str]:
    """Flatten folders in display order, deduping by first valid membership."""
    by_code = {e.code for e in doc.entries}
    seen: set[str] = set()
    out: list[str] = []
    for folder in ordered_folders(doc):
        for code in folder.member_codes:
            if code in seen:
                continue
            if code not in by_code:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    code,
                    folder.id,
                )
                continue
            seen.add(code)
            out.append(code)
    return out


def project_folder_views(doc: WatchlistDocument) -> list[WatchlistFolderView]:
    """Wire folder rows in display order."""
    return [
        WatchlistFolderView(
            id=folder.id,
            name=folder.name,
            order=folder.order,
            capture_enabled=folder.capture_enabled,
        )
        for folder in ordered_folders(doc)
    ]


def capture_ordered_codes(
    doc: WatchlistDocument,
    *,
    known_codes: set[str] | None = None,
) -> list[str]:
    by_code = {e.code for e in doc.entries}
    seen: set[str] = set()
    out: list[str] = []
    for folder in ordered_folders(doc):
        if not folder.capture_enabled:
            continue
        for code in folder.member_codes:
            if code in seen:
                continue
            if code not in by_code:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    code,
                    folder.id,
                )
                continue
            if known_codes is not None and code not in known_codes:
                continue
            seen.add(code)
            out.append(code)
    return out


def project_entry_views(doc: WatchlistDocument) -> list[WatchlistEntryView]:
    """Explode folder memberships into wire entry rows.

    Multi-folder codes intentionally appear once per folder. Drift is skipped on
    reads so one bad membership does not make the whole Watchlist unavailable.
    """
    by_code = {entry.code: entry for entry in doc.entries}
    views: list[WatchlistEntryView] = []
    for folder in ordered_folders(doc):
        for order, code in enumerate(folder.member_codes):
            base = by_code.get(code)
            if base is None:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    code,
                    folder.id,
                )
                continue
            views.append(
                WatchlistEntryView(
                    code=base.code,
                    name=base.name,
                    registered_at_kst_date=base.registered_at_kst_date,
                    last_success_date=base.last_success_date,
                    folder_id=folder.id,
                    order=order,
                )
            )
    return views


def first_membership_positions(doc: WatchlistDocument) -> dict[str, tuple[str, int]]:
    """Return each valid code's first display membership as (folder_id, order)."""
    by_code = {e.code for e in doc.entries}
    positions: dict[str, tuple[str, int]] = {}
    for folder in ordered_folders(doc):
        for order, code in enumerate(folder.member_codes):
            if code in positions:
                continue
            if code not in by_code:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    code,
                    folder.id,
                )
                continue
            positions[code] = (folder.id, order)
    return positions


def project_watchlist_response(
    doc: WatchlistDocument,
    *,
    next_run_at_ms: int,
) -> WatchlistResponse:
    """Project the store document into the consumer wire model."""
    return WatchlistResponse(
        folders=project_folder_views(doc),
        entries=project_entry_views(doc),
        next_run_at_ms=next_run_at_ms,
    )
