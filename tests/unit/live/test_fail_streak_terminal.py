"""Unit + integration tests for apply_terminal_to_manifest (ADR-0042).

Covers the pure-function semantics (done+COMPLETE resets / done-but-incomplete,
failed, skipped increment / cancelled no-op / unknown raises) and the in-process
wiring (worker terminal through _finalize_item updates the persisted manifest,
reading the on-disk DiskState to decide whether a ``done`` capture resets or
increments the counter — ADR-0042 amendment 2026-06-03).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from hoga.api.captures import (
    _apply_terminal_to_streaks,
    apply_terminal_to_manifest,
)
from hoga.api.models import QueueManifest


def _empty() -> QueueManifest:
    return QueueManifest(paused=False, items=[], fail_streaks={})


def _write_meta(
    data_dir: Path, code: str, date: str, *, collection_complete: bool, is_partial: bool,
) -> None:
    """Write a Stock-Date meta.json so ``check_disk_state`` classifies it.

    ``collection_complete=True, is_partial=False`` → COMPLETE (counter resets).
    ``collection_complete=False``                  → CLIENT_INCOMPLETE (counter +1).

    Session open/close are plausible KRX values so the meta-shape invariant
    checks (ADR-0020) don't raise an ``error`` violation that would force INVALID
    independently of the completeness flag.
    """
    meta_path = data_dir / "parquet" / date / code / "meta.json"
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps({
        "collection_complete": collection_complete,
        "is_partial": is_partial,
        "regular_session_open_ms": 90_000_000,    # 09:00 HHMMSSmmm
        "regular_session_close_ms": 153_100_000,  # 15:31 HHMMSSmmm
    }))


# --- pure function: apply_terminal_to_manifest -----------------------------


def test_done_complete_resets_counter_to_zero() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done", done_complete=True)
    assert m.fail_streaks.get("005930|20260520", 0) == 0


def test_done_complete_removes_zero_key_to_keep_manifest_tidy() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done", done_complete=True)
    assert "005930|20260520" not in m.fail_streaks


def test_done_incomplete_increments_from_existing() -> None:
    # ADR-0042 amendment: phase=done but NOT COMPLETE on disk (e.g.
    # stagnation_abort) is a failed attempt — it must increment, not reset.
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done", done_complete=False)
    assert m.fail_streaks["005930|20260520"] == 5


def test_done_incomplete_increments_from_missing() -> None:
    # First-ever capture of a date that comes back incomplete counts from 1 —
    # the amendment counts from the first attempt, like failed/skipped.
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "done", done_complete=False)
    assert m.fail_streaks["005930|20260520"] == 1


def test_done_complete_default_is_increment_not_reset() -> None:
    # Safety: omitting done_complete (default False) treats a `done` as
    # incomplete (+1), never a silent reset of an unclassified capture.
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 2})
    apply_terminal_to_manifest(m, "005930", "20260520", "done")
    assert m.fail_streaks["005930|20260520"] == 3


def test_done_incomplete_then_complete_clears_streak() -> None:
    # ADR-0042 amendment names the 06-02 multi-pass case: a date that comes back
    # incomplete twice then finally COMPLETE must be FULLY cleared (not left at a
    # nonzero floor) — resume-to-completion is never penalized once it lands.
    m = _empty()
    apply_terminal_to_manifest(m, "180640", "20260602", "done", done_complete=False)
    apply_terminal_to_manifest(m, "180640", "20260602", "done", done_complete=False)
    assert m.fail_streaks["180640|20260602"] == 2
    apply_terminal_to_manifest(m, "180640", "20260602", "done", done_complete=True)
    assert "180640|20260602" not in m.fail_streaks


def test_five_done_incompletes_reach_block_threshold() -> None:
    # Ties the counter to the cap predicate: 5 consecutive done-incomplete
    # terminals (the 180640/20260601 stagnation_abort case) arm the block.
    from hoga.api.fail_streak import is_blocked
    m = _empty()
    for _ in range(5):
        apply_terminal_to_manifest(m, "180640", "20260601", "done", done_complete=False)
    assert m.fail_streaks["180640|20260601"] == 5
    assert is_blocked(m, "180640", "20260601") is True


def test_failed_increments_from_missing() -> None:
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 1


def test_failed_increments_from_existing() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 4


def test_skipped_increments_alongside_failed() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 2})
    apply_terminal_to_manifest(m, "005930", "20260520", "skipped")
    assert m.fail_streaks["005930|20260520"] == 3


def test_cancelled_does_not_change_counter() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 3})
    apply_terminal_to_manifest(m, "005930", "20260520", "cancelled")
    assert m.fail_streaks["005930|20260520"] == 3


def test_cancelled_does_not_create_key_when_absent() -> None:
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "cancelled")
    assert "005930|20260520" not in m.fail_streaks


def test_unknown_phase_raises() -> None:
    m = _empty()
    with pytest.raises(ValueError, match="unexpected terminal phase"):
        apply_terminal_to_manifest(m, "005930", "20260520", "queued")  # non-terminal


def test_each_code_date_pair_is_independent() -> None:
    m = _empty()
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    apply_terminal_to_manifest(m, "003490", "20260319", "failed")
    apply_terminal_to_manifest(m, "005930", "20260520", "failed")
    assert m.fail_streaks["005930|20260520"] == 2
    assert m.fail_streaks["003490|20260319"] == 1


# --- inner helper directly on a dict (mirrors the in-process call site) ----


def test_apply_terminal_to_streaks_mutates_dict_in_place() -> None:
    fs: dict[str, int] = {"005930|20260520": 2}
    _apply_terminal_to_streaks(fs, "005930", "20260520", "failed")
    assert fs == {"005930|20260520": 3}


# --- integration: _finalize_item → manifest persistence -------------------


def test_finalize_item_failed_increments_persisted_counter(tmp_path: Path) -> None:
    """End-to-end: worker hits _finalize_item with phase=failed →
    counter increments AND the new manifest is persisted to .queue.json."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import load_manifest

    # Wire data_dir + seed _fail_streaks with 2 prior failures for (005930, 20260520).
    cap._data_dir = tmp_path
    cap._fail_streaks.clear()
    cap._fail_streaks["005930|20260520"] = 2

    # Build a minimal failed-phase state and feed it through _finalize_item.
    state = cap.QueueItemState(
        item_id="t1",
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=0,
        pause_origin=False,
        phase="failed",
    )
    asyncio.run(cap._finalize_item(state))

    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert persisted.fail_streaks.get("005930|20260520") == 3

    # cleanup module globals so other tests don't see state
    cap._fail_streaks.clear()
    cap._done.clear()
    cap._data_dir = None


def test_finalize_item_done_complete_resets_persisted_counter(tmp_path: Path) -> None:
    """A capture that leaves a COMPLETE Stock-Date on disk wipes the counter.

    phase="done" alone is not enough — _finalize_item reads the on-disk
    DiskState; only COMPLETE resets (ADR-0042 amendment / ADR-0034 predicate)."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import load_manifest

    cap._data_dir = tmp_path
    cap._fail_streaks.clear()
    cap._fail_streaks["005930|20260520"] = 4
    _write_meta(tmp_path, "005930", "20260520", collection_complete=True, is_partial=False)

    state = cap.QueueItemState(
        item_id="t2",
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=0,
        pause_origin=False,
        phase="done",
    )
    asyncio.run(cap._finalize_item(state))

    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert "005930|20260520" not in persisted.fail_streaks

    cap._fail_streaks.clear()
    cap._done.clear()
    cap._data_dir = None


def test_finalize_item_done_incomplete_increments_persisted_counter(tmp_path: Path) -> None:
    """ADR-0042 amendment regression (the 180640/20260601 production case).

    A capture that returns phase=done but leaves a NON-COMPLETE Stock-Date on
    disk (here collection_complete=False — the stagnation_abort signature) is a
    failed attempt: it must INCREMENT the persisted counter, not reset it.
    Pre-amendment this reset every time, so the date escaped the cap forever and
    was re-captured unboundedly (×16 observed in production)."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import load_manifest

    cap._data_dir = tmp_path
    cap._fail_streaks.clear()
    cap._fail_streaks["180640|20260601"] = 4
    _write_meta(tmp_path, "180640", "20260601", collection_complete=False, is_partial=True)

    state = cap.QueueItemState(
        item_id="t-incomplete",
        code="180640",
        date="20260601",
        force_retry=False,
        enqueued_at_ms=0,
        pause_origin=False,
        phase="done",
    )
    asyncio.run(cap._finalize_item(state))

    persisted = load_manifest(tmp_path)
    assert persisted is not None
    # 4 → 5 ⇒ now at attempt_cap, so the NEXT enqueue is rejected as blocked.
    assert persisted.fail_streaks.get("180640|20260601") == 5

    cap._fail_streaks.clear()
    cap._done.clear()
    cap._data_dir = None


def test_finalize_item_cancelled_leaves_counter_unchanged(tmp_path: Path) -> None:
    """Cancellation does not touch the fail_streak counter."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import load_manifest

    cap._data_dir = tmp_path
    cap._fail_streaks.clear()
    cap._fail_streaks["005930|20260520"] = 3

    state = cap.QueueItemState(
        item_id="t3",
        code="005930",
        date="20260520",
        force_retry=False,
        enqueued_at_ms=0,
        pause_origin=False,
        phase="cancelled",
    )
    asyncio.run(cap._finalize_item(state))

    persisted = load_manifest(tmp_path)
    assert persisted is not None
    assert persisted.fail_streaks.get("005930|20260520") == 3

    cap._fail_streaks.clear()
    cap._done.clear()
    cap._data_dir = None


# --- restore-side wiring ---------------------------------------------------


def test_restore_queue_from_manifest_restores_fail_streaks(tmp_path: Path) -> None:
    """ADR-0042 restore-side: loading a manifest rehydrates _fail_streaks."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import save_manifest

    save_manifest(
        tmp_path,
        QueueManifest(
            paused=False,
            items=[],
            fail_streaks={"005930|20260520": 4, "003490|20260319": 2},
        ),
    )

    cap._fail_streaks.clear()
    cap._restore_queue_from_manifest(tmp_path)

    assert cap._fail_streaks == {"005930|20260520": 4, "003490|20260319": 2}

    cap._fail_streaks.clear()
