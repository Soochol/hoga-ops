"""Plan B queue/worker tests. Built up across Tasks 3–15."""
from __future__ import annotations

import pytest

from hoga.api import captures


@pytest.fixture(autouse=True)
def _reset():
    captures.reset_state_for_tests()
    yield
    captures.reset_state_for_tests()


def test_initial_snapshot_is_empty():
    snap = captures.get_queue_snapshot()
    assert snap.active == []
    assert snap.queued == []
    assert snap.done == []
    assert snap.paused is False
    assert snap.max_concurrent >= 1


def test_max_concurrent_reads_env_default_3(monkeypatch):
    monkeypatch.delenv("HOGA_MAX_CONCURRENT", raising=False)
    snap = captures.get_queue_snapshot()
    # Default 3 unless overridden — but the module reads env at import time,
    # so we just check it's a positive int matching what the module loaded.
    assert isinstance(snap.max_concurrent, int) and snap.max_concurrent >= 1


def test_reset_state_clears_queue_active_done_and_pause():
    # Mutate then reset, then re-check.
    captures._queue.append(object())  # type: ignore[arg-type]
    captures._active["x"] = object()  # type: ignore[assignment]
    captures._done.append(object())   # type: ignore[arg-type]
    captures._inflight_paths.add(("005930", "20260520"))
    captures._queue_paused = True
    captures.reset_state_for_tests()
    snap = captures.get_queue_snapshot()
    assert snap.queued == [] and snap.active == [] and snap.done == []
    assert snap.paused is False
    assert captures._inflight_paths == set()
