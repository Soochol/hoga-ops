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
import logging
from pathlib import Path

from hoga.api.calendar import trading_days_in_range
from hoga.api.captures import enqueue_items_core
from hoga.api.models import EnqueueRequest
from hoga.api.watchlist import load_watchlist
from hoga.collector.orchestrator import now_kst

log = logging.getLogger(__name__)


def seconds_until_next_18_kst(now: dt.datetime) -> float:
    """Seconds from ``now`` until the next KST 18:00 boundary.

    If ``now`` is exactly 18:00 or later, returns the duration to
    *tomorrow's* 18:00. ``now`` must be tz-aware (Asia/Seoul).
    """
    today_18 = now.replace(hour=18, minute=0, second=0, microsecond=0)
    target = today_18 if now < today_18 else today_18 + dt.timedelta(days=1)
    return (target - now).total_seconds()


async def _daily_run(data_dir: Path) -> None:
    """Enqueue ``(code, today_kst)`` for every Watchlist entry on a
    trading day. Per-entry exceptions are logged; the loop continues.
    """
    now = now_kst()
    today = now.strftime("%Y%m%d")
    try:
        trading = trading_days_in_range(today, today)
    except Exception:  # noqa: BLE001
        log.warning("daily run: trading-day check failed, skipping")
        return
    if today not in trading:
        log.info("daily run: %s is not a trading day, skipping", today)
        return
    wl = load_watchlist(data_dir)
    for entry in wl.entries:
        try:
            await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=[today]),
                data_dir=data_dir,
                now=now,
            )
        except Exception:  # noqa: BLE001 — one bad entry mustn't kill the run
            log.exception("daily enqueue failed for %s/%s", entry.code, today)
