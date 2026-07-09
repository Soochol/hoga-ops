"""ADR-0094: single queue owner per data dir (flock-based)."""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from hoga.api import captures
from hoga.api.queue_ownership import (
    lock_path,
    try_acquire_queue_ownership,
)


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def _write_manifest(data_dir: Path, payload: dict) -> None:
    (data_dir / ".queue.json").write_text(json.dumps(payload), encoding="utf-8")


# --- lock primitive --------------------------------------------------------


def test_second_acquire_returns_none_while_first_holds(tmp_path):
    first = try_acquire_queue_ownership(tmp_path)
    assert first is not None
    try:
        second = try_acquire_queue_ownership(tmp_path)
        assert second is None  # flock is exclusive on the same file
    finally:
        first.release()


def test_reacquire_succeeds_after_release(tmp_path):
    first = try_acquire_queue_ownership(tmp_path)
    assert first is not None
    first.release()
    second = try_acquire_queue_ownership(tmp_path)
    assert second is not None
    second.release()


def test_lock_file_records_owner_hint(tmp_path):
    owner = try_acquire_queue_ownership(tmp_path)
    assert owner is not None
    try:
        hint = lock_path(tmp_path).read_text(encoding="utf-8")
        assert "pid=" in hint
    finally:
        owner.release()


# --- start_capture_pool ownership wiring -----------------------------------


def test_pool_owner_restores_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    # Isolate ownership/restore from worker execution — a bare start_workers()
    # would asyncio.create_task in a sync test (no loop) and process real items.
    monkeypatch.setattr(captures, "start_workers", lambda: [])
    _write_manifest(tmp_path, {
        "schema_version": 1, "paused": False,
        "items": [
            {"item_id": "id1", "code": "005930", "date": "20260520",
             "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False},
        ],
    })
    # No competing holder — this instance becomes the owner.
    captures.start_capture_pool(tmp_path)
    try:
        assert captures._queue_owned is True
        snap = captures.get_queue_snapshot()
        assert snap.queue_owned is True
        assert [i.item_id for i in snap.queued] == ["id1"]
    finally:
        captures.release_queue_ownership()


def test_pool_non_owner_skips_restore_and_workers(monkeypatch, tmp_path):
    # A competing process already holds the lock.
    holder = try_acquire_queue_ownership(tmp_path)
    assert holder is not None
    try:
        monkeypatch.setattr(captures, "_data_dir", tmp_path)
        _write_manifest(tmp_path, {
            "schema_version": 1, "paused": False,
            "items": [
                {"item_id": "id1", "code": "005930", "date": "20260520",
                 "force_retry": False, "enqueued_at_ms": 1, "pause_origin": False},
            ],
        })
        workers = captures.start_capture_pool(tmp_path)
        assert workers == []                      # no worker pool spawned
        assert captures._queue_owned is False
        snap = captures.get_queue_snapshot()
        assert snap.queue_owned is False
        assert snap.queued == []                  # manifest NOT restored
    finally:
        holder.release()


def test_env_optout_runs_read_only_without_lock(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setenv("HOGA_CAPTURE_QUEUE_DISABLED", "1")
    workers = captures.start_capture_pool(tmp_path)
    assert workers == []
    assert captures._queue_owned is False
    # A different process can still take the lock since we never contended.
    other = try_acquire_queue_ownership(tmp_path)
    assert other is not None
    other.release()


# --- persistence no-op on non-owner ----------------------------------------


@pytest.mark.asyncio
async def test_non_owner_persist_is_noop(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_queue_owned", False)
    async with captures._lock:
        captures._persist_queue_locked()
    assert not (tmp_path / ".queue.json").exists()


@pytest.mark.asyncio
async def test_owner_persist_writes_manifest(monkeypatch, tmp_path):
    monkeypatch.setattr(captures, "_data_dir", tmp_path)
    monkeypatch.setattr(captures, "_queue_owned", True)
    async with captures._lock:
        captures._persist_queue_locked()
    assert (tmp_path / ".queue.json").exists()


# --- mutation endpoint guard -----------------------------------------------


def test_require_queue_ownership_raises_503_when_not_owned(monkeypatch):
    from fastapi import HTTPException

    from hoga.api.error_codes import CaptureErrorCode

    monkeypatch.setattr(captures, "_queue_owned", False)
    with pytest.raises(HTTPException) as exc:
        captures._require_queue_ownership()
    assert exc.value.status_code == 503
    assert exc.value.detail["code"] == CaptureErrorCode.QUEUE_NOT_OWNED


def test_require_queue_ownership_passes_when_owned(monkeypatch):
    monkeypatch.setattr(captures, "_queue_owned", True)
    captures._require_queue_ownership()  # no raise
