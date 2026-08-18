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
    WatchlistMemoItem,
    WatchlistMemoView,
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
        for code in folder.code_members():
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
        for code in folder.code_members():
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

    `order` 는 폴더의 **items 인덱스**다(v4) — 메모 행이 차지한 자리를 건너뛰므로
    이 배열만 보면 값이 띄엄띄엄하다. `project_memo_views` 가 같은 축을 쓰고, 둘을
    합치면 폴더당 0..N-1 로 조밀하다. 프론트는 그 합집합을 order 로 정렬해 원래
    표시 순서를 복원한다.
    """
    by_code = {entry.code: entry for entry in doc.entries}
    capture_candidates = set(capture_ordered_codes(doc))
    views: list[WatchlistEntryView] = []
    for folder in ordered_folders(doc):
        for order, item in enumerate(folder.items):
            if isinstance(item, WatchlistMemoItem):
                continue
            base = by_code.get(item.code)
            if base is None:
                log.warning(
                    "watchlist.drift: member %s in folder %s has no entry (skipped)",
                    item.code,
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
                    capture_candidate=base.code in capture_candidates,
                )
            )
    return views


def project_memo_views(doc: WatchlistDocument) -> list[WatchlistMemoView]:
    """Memo ("빈칸") rows in display order, one per folder item.

    `order` 는 `project_entry_views` 와 **같은 축**(폴더 items 인덱스)이다. 메모는
    entry 를 갖지 않으므로 drift 검사 대상이 아니다 — 스킵할 조건 자체가 없다.
    """
    return [
        WatchlistMemoView(id=item.id, folder_id=folder.id, order=order, text=item.text)
        for folder in ordered_folders(doc)
        for order, item in enumerate(folder.items)
        if isinstance(item, WatchlistMemoItem)
    ]


def first_membership_positions(doc: WatchlistDocument) -> dict[str, tuple[str, int]]:
    """Return each valid code's first display membership as (folder_id, order).

    ⚠ 여기의 `order` 는 `project_entry_views` 와 **다른 축**이다 — 메모를 제외한
    **코드 전용 조밀 인덱스**(0..M-1)다. 소비자가 히트맵 시드 배치이고(heatmap.py),
    히트맵 보드에는 메모 개념이 없어 빈자리가 생기면 안 되기 때문이다. 두 축을
    통일하려 들지 말 것 — 서로 다른 보드의 좌표계다.
    """
    by_code = {e.code for e in doc.entries}
    positions: dict[str, tuple[str, int]] = {}
    for folder in ordered_folders(doc):
        for order, code in enumerate(folder.code_members()):
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
        memos=project_memo_views(doc),
        next_run_at_ms=next_run_at_ms,
    )
