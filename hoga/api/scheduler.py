"""Daily Scheduler + Catch-up Run for the Watchlist.

See CONTEXT.md ("Daily Scheduler", "Catch-up Run"), spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md,
and ADR-0034 (Scheduler is a queue client, not a peer).

The scheduler MUST go through ``captures.enqueue_items_core`` for all
enqueues. Direct manipulation of ``captures._queue`` / ``_active`` /
``_done`` is forbidden — see ADR-0034.
"""
from __future__ import annotations

import datetime as dt


def seconds_until_next_18_kst(now: dt.datetime) -> float:
    """Seconds from ``now`` until the next KST 18:00 boundary.

    If ``now`` is exactly 18:00 or later, returns the duration to
    *tomorrow's* 18:00. ``now`` must be tz-aware (Asia/Seoul).
    """
    today_18 = now.replace(hour=18, minute=0, second=0, microsecond=0)
    target = today_18 if now < today_18 else today_18 + dt.timedelta(days=1)
    return (target - now).total_seconds()
