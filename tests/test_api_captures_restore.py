"""Tests for _restore_queue_from_manifest — Task 5."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api import captures


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def _write_manifest(data_dir: Path, payload: dict) -> None:
    (data_dir / ".queue.json").write_text(
        json.dumps(payload), encoding="utf-8"
    )


def test_restore_no_manifest_leaves_queue_empty(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    assert snap.active == []
    assert snap.paused is False


def test_restore_populates_queue_in_manifest_order(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": False,
        "items": [
            {"item_id": "id1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False},
            {"item_id": "id2", "code": "005930", "date": "20260519",
             "force_retry": True, "enqueued_at_ms": 2, "pause_origin": False},
        ],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert [i.item_id for i in snap.queued] == ["id1", "id2"]
    assert snap.queued[0].phase == "queued"  # always reset to queued
    assert snap.queued[1].force_retry is True


def test_restore_preserves_paused_flag(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1, "paused": True, "items": [],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.paused is True


def test_restore_preserves_pause_origin(monkeypatch, tmp_path):
    """pause_origin items route to _done (phase="cancelled") so resume_queue
    can re-enqueue them. ADR-0019 follow-up — see also the dedicated
    pause_origin routing + end-to-end resume tests below."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": True,
        "items": [{"item_id": "id1", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": True}],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.done[0].pause_origin is True
    assert snap.done[0].phase == "cancelled"


def test_restore_quarantines_corrupt_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    (tmp_path / ".queue.json").write_text("not json", encoding="utf-8")
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued == []
    # Quarantine file present
    assert list(tmp_path.glob(".queue.json.corrupt-*"))


def test_restore_resets_phase_to_queued_even_if_manifest_says_otherwise(monkeypatch, tmp_path):
    """Defense in depth: even if a future schema version persisted phase,
    on restore we ALWAYS reset to queued so decide_capture re-routes."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": False,
        "items": [{"item_id": "id1", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False}],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued[0].phase == "queued"


def test_restore_routes_pause_origin_items_to_done_for_resume(monkeypatch, tmp_path):
    """ADR-0019 gap fix: items with pause_origin=True must restore into _done
    (phase="cancelled") so resume_queue() can re-enqueue them after the user
    refreshes the cookie. Items without pause_origin keep the legacy queued
    behaviour."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": True,
        "items": [
            {"item_id": "active-when-crashed", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1, "pause_origin": True},
            {"item_id": "queued-only", "code": "005930", "date": "20260519",
             "force_retry": False, "enqueued_at_ms": 2, "pause_origin": False},
        ],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()

    # The pause_origin item is staged in _done with phase="cancelled" so
    # resume_queue() can find it.
    assert [d.item_id for d in snap.done] == ["active-when-crashed"]
    assert snap.done[0].phase == "cancelled"
    assert snap.done[0].pause_origin is True

    # The non-pause_origin item lands in _queue as before.
    assert [q.item_id for q in snap.queued] == ["queued-only"]
    assert snap.queued[0].pause_origin is False
    assert snap.paused is True


async def test_resume_queue_re_enqueues_restored_pause_origin_items(monkeypatch, tmp_path):
    """End-to-end recovery of the ADR-0019 gap: restore + user-triggered
    resume must put the pause_origin item back into _queue with
    phase="queued" + pause_origin=False, just like the in-process path
    (test_resume_reenqueues_pause_origin)."""
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": True,
        "items": [
            {"item_id": "p1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1, "pause_origin": True},
        ],
    })
    captures._restore_queue_from_manifest(tmp_path)
    # Sanity: in _done before resume.
    assert [d.item_id for d in captures.get_queue_snapshot().done] == ["p1"]

    await captures.resume_queue()
    snap = captures.get_queue_snapshot()
    assert [q.item_id for q in snap.queued] == ["p1"]
    assert snap.queued[0].phase == "queued"
    assert snap.queued[0].pause_origin is False
    assert snap.done == []
    assert snap.paused is False
