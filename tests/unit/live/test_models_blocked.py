"""Tests for BlockedItem + EnqueueResponse.blocked (ADR-0042)."""
from __future__ import annotations

from hoga.api.models import BlockedItem, EnqueueResponse


def test_blocked_item_shape() -> None:
    b = BlockedItem(code="005930", date="20260520", fail_streak=5, reason="fail_streak_exceeded")
    assert b.code == "005930"
    assert b.date == "20260520"
    assert b.fail_streak == 5
    assert b.reason == "fail_streak_exceeded"


def test_enqueue_response_blocked_defaults_empty() -> None:
    """Old code paths that construct EnqueueResponse without blocked= still work."""
    r = EnqueueResponse(enqueued=[], deduped=[])
    assert r.blocked == []


def test_enqueue_response_with_blocked() -> None:
    r = EnqueueResponse(
        enqueued=[],
        deduped=[],
        blocked=[
            BlockedItem(code="003490", date="20260319", fail_streak=5, reason="fail_streak_exceeded"),
        ],
    )
    assert len(r.blocked) == 1
    assert r.blocked[0].fail_streak == 5


def test_enqueue_response_serializes_blocked() -> None:
    """blocked field is present in JSON output even when empty (forward-compat)."""
    r = EnqueueResponse(enqueued=[], deduped=[])
    dumped = r.model_dump(mode="json")
    assert "blocked" in dumped
    assert dumped["blocked"] == []
