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
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    _write_manifest(tmp_path, {
        "schema_version": 1,
        "paused": True,
        "items": [{"item_id": "id1", "code": "005930", "date": "20260520",
                   "force_retry": False, "enqueued_at_ms": 1, "pause_origin": True}],
    })
    captures._restore_queue_from_manifest(tmp_path)
    snap = captures.get_queue_snapshot()
    assert snap.queued[0].pause_origin is True


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
