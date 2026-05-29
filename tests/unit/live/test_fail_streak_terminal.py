"""Unit + integration tests for apply_terminal_to_manifest (ADR-0042).

Covers the pure-function semantics (done resets / failed+skipped increment /
cancelled no-op / unknown raises) and the in-process wiring (worker terminal
through _finalize_item updates the persisted manifest).
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from hoga.api.captures import (
    _apply_terminal_to_streaks,
    apply_terminal_to_manifest,
)
from hoga.api.models import QueueManifest


def _empty() -> QueueManifest:
    return QueueManifest(paused=False, items=[], fail_streaks={})


# --- pure function: apply_terminal_to_manifest -----------------------------


def test_done_resets_counter_to_zero() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done")
    assert m.fail_streaks.get("005930|20260520", 0) == 0


def test_done_removes_zero_key_to_keep_manifest_tidy() -> None:
    m = QueueManifest(paused=False, items=[], fail_streaks={"005930|20260520": 4})
    apply_terminal_to_manifest(m, "005930", "20260520", "done")
    assert "005930|20260520" not in m.fail_streaks


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


def test_finalize_item_done_resets_persisted_counter(tmp_path: Path) -> None:
    """A successful capture wipes the counter for that (Code, Stock-Date)."""
    import hoga.api.captures as cap
    from hoga.api.captures_persistence import load_manifest

    cap._data_dir = tmp_path
    cap._fail_streaks.clear()
    cap._fail_streaks["005930|20260520"] = 4

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
