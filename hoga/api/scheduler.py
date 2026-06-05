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
from hoga.api.disk_state import latest_complete_date
from hoga.api.eligibility import find_ineligible_dates
from hoga.api.models import EnqueueRequest, EnqueueResponse, WatchlistEntry
from hoga.api.watchlist import load_watchlist, set_last_success
from hoga.collector.orchestrator import next_kst_day, now_kst

log = logging.getLogger(__name__)


def seconds_until_next_17_kst(now: dt.datetime) -> float:
    """Seconds from ``now`` until the next KST 17:00 boundary.

    If ``now`` is exactly 17:00 or later, returns the duration to
    *tomorrow's* 17:00. ``now`` must be tz-aware (Asia/Seoul).
    """
    today_17 = now.replace(hour=17, minute=0, second=0, microsecond=0)
    target = today_17 if now < today_17 else today_17 + dt.timedelta(days=1)
    return (target - now).total_seconds()


def _log_blocked(resp: EnqueueResponse, *, context: str) -> None:
    """Surface fail_streak-blocked (Code, Stock-Date)s rejected by the enqueue gate.

    The daily/catch-up sweep enqueues through ``enqueue_items_core``, whose
    ADR-0042 cap can reject a (Code, Stock-Date) as ``blocked`` — e.g. a Watchlist
    date stuck in ``stagnation_abort`` that now counts as a failed attempt
    (ADR-0042 amendment 2026-06-03). ``enqueue_items_core`` returns these on
    ``resp.blocked`` (it does NOT raise), so without this they vanish silently and
    the date quietly drops out of unattended capture. Warn so the operator knows
    to clear it via the inventory ``잠금 해제`` action.
    """
    for item in resp.blocked:
        log.warning(
            "%s: %s/%s blocked (fail_streak=%d, %s) — not enqueued; "
            "clear via inventory unblock",
            context, item.code, item.date, item.fail_streak, item.reason,
        )


async def _daily_run(data_dir: Path) -> None:
    """Enqueue ``(code, today_kst)`` for every Watchlist entry on a
    trading day. Per-entry exceptions are logged; the loop continues.
    """
    # Stage 8: Promote pending Live Capture JSONLs before hogaplay enqueue (ADR-0038).
    from hoga.live.promote import cleanup_archive, promote_pending
    try:
        await promote_pending(data_dir)
        await cleanup_archive(data_dir)
    except Exception:  # noqa: BLE001 — one source of failure mustn't block the other
        log.exception("daily run: live promotion failed; continuing to hogaplay enqueue")

    now = now_kst()
    today = now.strftime("%Y%m%d")
    try:
        # to_thread: a cold-month KIS chk-holiday fetch is blocking sync HTTP —
        # never run it on the event loop (the live poller shares this loop).
        trading = await asyncio.to_thread(trading_days_in_range, today, today)
    except Exception:  # noqa: BLE001
        log.warning("daily run: trading-day check failed, skipping")
        return
    if today not in trading:
        log.info("daily run: %s is not a trading day, skipping", today)
        return
    for entry in load_watchlist(data_dir):
        try:
            resp = await enqueue_items_core(
                EnqueueRequest(code=entry.code, dates=[today]),
                data_dir=data_dir,
                now=now,
            )
            _log_blocked(resp, context="daily")
        except Exception:  # noqa: BLE001 — one bad entry mustn't kill the run
            log.exception("daily enqueue failed for %s/%s", entry.code, today)

    # Screener daily gap update (local import avoids an import cycle). A
    # screener failure must not kill the rest of the daily run.
    try:
        from hoga.api import screener
        await screener.trigger_update(data_dir)
    except Exception:  # noqa: BLE001
        log.exception("daily run: screener update failed; continuing")


async def catchup_one_entry(
    entry: WatchlistEntry,
    *,
    data_dir: Path,
    now: dt.datetime,
) -> EnqueueResponse:
    """Backfill one Watchlist entry. Used by:
    - _catchup_run (startup)
    - POST /api/watchlist/{code}/catchup (per-row)
    - POST /api/watchlist/catchup (run-all)

    Reconciles last_success_date with the disk first (idempotent), then
    enqueues the trading-day gap up to today (Q14-trimmed). Returns
    EnqueueResponse(enqueued=[], deduped=[]) on no-gap or fully-Q14-trimmed
    cases. Raises :class:`TradingDayUnavailableError` when the KIS calendar is
    unavailable — swallowing it here made the routes' error envelope
    unreachable, so a KIS outage reported per-entry SUCCESS (enqueued=0,
    error=None) and the gap silently persisted.
    """
    today = now.strftime("%Y%m%d")

    # Step 1: reconcile last_success_date with disk truth (bidirectional).
    # The disk classifier (DiskState.COMPLETE on meta.json) is authoritative;
    # the marker is a cache. Sync in *either* direction:
    #   - latest > marker  → advance (normal catch-up after offline period)
    #   - latest < marker  → regress (marker was stale, e.g. a previous
    #                        finalize bumped past actual COMPLETE because
    #                        of an abort_reason that wasn't yet gated on
    #                        disk_state — see captures._finalize_item)
    #   - latest is None and marker is set → reset to None (parquet wiped)
    # The finalize-side path uses bump_last_success (advance-only) for
    # race safety; reconcile uses set_last_success because it must be able
    # to repair stale-too-high markers.
    latest = latest_complete_date(data_dir, entry.code)
    if latest != entry.last_success_date:
        await set_last_success(data_dir, code=entry.code, date=latest)
    floor = latest or entry.registered_at_kst_date

    # Step 2: compute candidate dates. to_thread: cold-month KIS fetch is
    # blocking sync HTTP — keep it off the event loop. A
    # TradingDayUnavailableError propagates to the caller (routes map it to
    # their error envelope / 503; _catchup_run logs per entry).
    start = next_kst_day(floor)
    if start > today:
        return EnqueueResponse(enqueued=[], deduped=[])
    candidates = await asyncio.to_thread(trading_days_in_range, start, today)

    # Step 3: Q14 pre-trim.
    too_early = set(find_ineligible_dates(candidate_dates=candidates, now=now))
    candidates = [d for d in candidates if d not in too_early]
    if not candidates:
        return EnqueueResponse(enqueued=[], deduped=[])

    # Step 4: enqueue.
    return await enqueue_items_core(
        EnqueueRequest(code=entry.code, dates=candidates),
        data_dir=data_dir,
        now=now,
    )


async def _catchup_run(data_dir: Path) -> None:
    """Backfill every Watchlist entry on startup. Each entry is handled
    by catchup_one_entry; per-entry exceptions are logged. The startup
    sweep never aborts because one entry failed.
    """
    now = now_kst()
    for entry in load_watchlist(data_dir):
        try:
            resp = await catchup_one_entry(entry, data_dir=data_dir, now=now)
            _log_blocked(resp, context="catch-up")
        except Exception:  # noqa: BLE001
            log.exception("catch-up failed for %s", entry.code)


async def _daily_loop(data_dir: Path) -> None:
    """Perpetual: sleep to next KST 17:00, run _daily_run, repeat.

    Never lets a single failure kill the loop — see ADR-0034 for the
    "scheduler is a queue client" framing. The Capture Queue's own
    pause/resume semantics handle the heavyweight failures; this loop
    only ensures the *trigger* stays alive.
    """
    while True:
        await asyncio.sleep(seconds_until_next_17_kst(now_kst()))
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
