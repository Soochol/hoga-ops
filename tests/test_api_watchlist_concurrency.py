"""Every watchlist writer round-trips the WHOLE document, so folders survive
a sequence of writers and no entry is left with a dangling folder_id.
See ADR-0055 rule 2 ("the whole document is the unit of read and write"),
the design spec's Blocker #1 (entries-only saves would let the Scheduler
wipe folders on every capture success).

Several writers are dispatched via ``asyncio.gather``, but true interleaving
is NOT exercised here: every mutation body in hoga.api.watchlist is fully
synchronous (no ``await`` inside ``async with _lock``), so each gathered
coroutine runs its load -> mutate -> save to completion before yielding and
``_lock`` is never contended. This is a document-round-trip regression guard,
not a lock-contention test."""
from __future__ import annotations

import asyncio
from pathlib import Path


def test_folders_survive_multi_writer_document_roundtrip(tmp_path: Path):
    from hoga.api.watchlist import (create_folder, add_entry, move_entries,
                                    bump_last_success, load_document)

    async def scenario():
        f = await create_folder(tmp_path, name="스윙")
        for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
            await add_entry(tmp_path, code=c, name=n, today_kst_date="20260101")
        # drive several writers via gather: bumps (Scheduler-like) + moves.
        # Bodies are sync, so this is a sequence of round-trips, not true
        # interleaving; the last writer is a bump, which must still preserve
        # folders (the entries-only-save regression this guards against).
        await asyncio.gather(
            bump_last_success(tmp_path, code="005930", date="20260102"),
            move_entries(tmp_path, codes=["005930"], folder_id=f.id),
            bump_last_success(tmp_path, code="000660", date="20260103"),
            move_entries(tmp_path, codes=["000660"], folder_id=f.id),
            bump_last_success(tmp_path, code="035720", date="20260104"),
        )
        return f.id

    fid = asyncio.run(scenario())
    doc = load_document(tmp_path)
    assert doc.folders[0].id == fid            # folder survived all writers
    assert {e.code for e in doc.entries} == {"005930", "000660", "035720"}
    moved = {e.code: e for e in doc.entries}
    assert moved["005930"].folder_id == fid
    assert moved["000660"].folder_id == fid
    assert moved["005930"].last_success_date == "20260102"
    # no dangling folder_id (model_validator would have raised on load)
    valid = {f.id for f in doc.folders} | {None}
    assert all(e.folder_id in valid for e in doc.entries)
    # per-folder order contiguous
    fids = {}
    for e in doc.entries:
        fids.setdefault(e.folder_id, []).append(e.order)
    for orders in fids.values():
        assert sorted(orders) == list(range(len(orders)))
