"""Every watchlist writer round-trips the WHOLE document, so folders (and their
member_codes) survive a sequence of writers. See ADR-0055 rule 2 ("the whole
document is the unit of read and write") and ADR-0069 (folders own member_codes);
the design spec's Blocker #1 (entries-only saves would let the Scheduler wipe
folders on every capture success).

Several writers are dispatched via ``asyncio.gather``, but true interleaving is
NOT exercised here: every mutation body in hoga.api.watchlist is fully
synchronous (no ``await`` inside ``async with _lock``), so each gathered
coroutine runs its load -> mutate -> save to completion before yielding and
``_lock`` is never contended. This is a document-round-trip regression guard,
not a lock-contention test."""
from __future__ import annotations

import asyncio
from pathlib import Path


def test_folders_survive_multi_writer_document_roundtrip(tmp_path: Path):
    from hoga.api.watchlist import (create_folder, add_member,
                                    bump_last_success, load_document)

    async def scenario():
        f = await create_folder(tmp_path, name="스윙")
        for c, n in [("005930", "삼성"), ("000660", "SK"), ("035720", "카카오")]:
            await add_member(tmp_path, code=c, name=n,
                             today_kst_date="20260101", folder_id=f.id)
        # drive several writers via gather: bumps (Scheduler-like). Bodies are
        # sync, so this is a sequence of round-trips; the last writer is a bump,
        # which must still preserve folders + member_codes (the entries-only-save
        # regression this guards against).
        await asyncio.gather(
            bump_last_success(tmp_path, code="005930", date="20260102"),
            bump_last_success(tmp_path, code="000660", date="20260103"),
            bump_last_success(tmp_path, code="035720", date="20260104"),
        )
        return f.id

    fid = asyncio.run(scenario())
    doc = load_document(tmp_path)
    assert doc.folders[0].id == fid            # folder survived all writers
    assert {e.code for e in doc.entries} == {"005930", "000660", "035720"}
    # folder still owns all three members (round-trip preserved member_codes)
    assert set(doc.folders[0].member_codes) == {"005930", "000660", "035720"}
    marks = {e.code: e.last_success_date for e in doc.entries}
    assert marks["005930"] == "20260102"
    # invariant: every entry code is a member of some folder (ADR-0069)
    members = {c for f in doc.folders for c in f.member_codes}
    assert {e.code for e in doc.entries} == members
