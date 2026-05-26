"""Daily Scheduler + Catch-up Run for the Watchlist.

See CONTEXT.md ("Daily Scheduler", "Catch-up Run"), spec
docs/superpowers/specs/2026-05-26-watchlist-daily-scheduler-design.md,
and ADR-0034 (Scheduler is a queue client, not a peer).

The scheduler MUST go through ``captures.enqueue_items_core`` for all
enqueues. Direct manipulation of ``captures._queue`` / ``_active`` /
``_done`` is forbidden — see ADR-0034.
"""
from __future__ import annotations

import asyncio
import datetime as dt
import logging
from pathlib import Path

from hoga.api.calendar import trading_days_in_range
from hoga.api.captures import enqueue_items_core
from hoga.api.eligibility import find_ineligible_dates
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


def _next_kst_day(yyyymmdd: str) -> str:
    d = dt.date(int(yyyymmdd[0:4]), int(yyyymmdd[4:6]), int(yyyymmdd[6:8]))
    return (d + dt.timedelta(days=1)).strftime("%Y%m%d")


async def _catchup_run(data_dir: Path) -> None:
    """Backfill every Watchlist entry from its (last_success or
    registered_at) marker up to today. Pre-trims Q14-ineligible dates so
    a multi-day catch-up that includes today before 18:00 still enqueues
    the prior days successfully (see ADR-0034 carve-out).
    """
    now = now_kst()
    today = now.strftime("%Y%m%d")
    wl = load_watchlist(data_dir)
    for entry in wl.entries:
        floor = entry.last_success_date or entry.registered_at_kst_date
        start = _next_kst_day(floor)
        if start > today:
            continue
        try:
            candidates = trading_days_in_range(start, today)
        except Exception:  # noqa: BLE001 — KrxUnavailableError or worse
            log.warning("catch-up: trading-day list unavailable for %s",
                        entry.code)
            continue
        too_early = set(find_ineligible_dates(
            candidate_dates=candidates, now=now,
        ))
        candidates = [d for d in candidates if d not in too_early]
        if not candidates:
            continue
        try:
            await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=candidates),
                data_dir=data_dir,
                now=now,
            )
        except Exception:  # noqa: BLE001
            log.exception("catch-up enqueue failed for %s", entry.code)


async def _daily_loop(data_dir: Path) -> None:
    """Perpetual: sleep to next KST 18:00, run _daily_run, repeat.

    Never lets a single failure kill the loop — see ADR-0034 for the
    "scheduler is a queue client" framing. The Capture Queue's own
    pause/resume semantics handle the heavyweight failures; this loop
    only ensures the *trigger* stays alive.
    """
    while True:
        await asyncio.sleep(seconds_until_next_18_kst(now_kst()))
        try:
            await _daily_run(data_dir)
        except Exception:  # noqa: BLE001
            log.exception("daily run crashed; loop continues")


def start_scheduler(data_dir: Path) -> list[asyncio.Task]:
    """Spawn the catch-up (one-shot) and daily-loop tasks. Returns the
    handles so the FastAPI lifespan can cancel them on shutdown.
    """
    return [
        asyncio.create_task(_catchup_run(data_dir), name="watchlist-catchup"),
        asyncio.create_task(_daily_loop(data_dir), name="watchlist-daily-loop"),
    ]
