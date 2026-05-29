"""Per-(Code, Stock-Date) consecutive failed+skipped counter (ADR-0042).

This module provides pure read-side helpers. The write-side (mutating the
counter on worker terminal phase, clearing on unblock) lives in ``captures.py``
because it must coordinate with the manifest lock — see ADR-0019.
"""
from __future__ import annotations

from hoga.api.models import QueueManifest

ATTEMPT_CAP = 5
"""Exclusive upper bound on ``fail_streak`` for enqueue acceptance.

``fail_streak >= ATTEMPT_CAP`` ⇒ the (Code, Stock-Date) is blocked.
Concretely: 5 consecutive failed+skipped results are allowed (each was a
real worker outcome); the 6th enqueue is rejected. ADR-0042 "When to
revisit" — promoting to Settings is deferred.
"""


def streak_key(code: str, date: str) -> str:
    """Canonical key into ``QueueManifest.fail_streaks``."""
    return f"{code}|{date}"


def read_fail_streak(manifest: QueueManifest, code: str, date: str) -> int:
    """Return current fail_streak for (code, date). Missing key returns 0."""
    return manifest.fail_streaks.get(streak_key(code, date), 0)


def is_blocked(manifest: QueueManifest, code: str, date: str) -> bool:
    return read_fail_streak(manifest, code, date) >= ATTEMPT_CAP
