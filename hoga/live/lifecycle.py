"""Live Capture lifecycle singleton.

Owns the single in-process LivePoller instance and exposes a stable
`get_status()` callable for the API layer. The poller is driven through
`start_live_poller` / `stop_live_poller` (wired into FastAPI's lifespan);
`get_status()` is always safe to call and returns defaults before the
poller starts so `/api/live/status` works at any time.

Single-worker invariant: see ADR-0038. The module-level singleton is
safe because hoga/live/__init__.py asserts UVICORN_WORKERS == 1 at
import time.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

from pydantic import BaseModel, Field

from . import kis_runtime  # needed by reset_for_tests() + start_live_poller
from .buffer import LiveBuffer
from .promote import promote_today

_log = logging.getLogger(__name__)


class LiveStatus(BaseModel):
    """Wire model for GET /api/live/status (spec §6)."""

    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    watchlist_count: int
    kis_calls_today: int
    kis_rate_limit_remaining: int | None
    # ADR-0043 / design-review B2 — last successful Today Promotion per code (epoch ms).
    # Empty dict means no promotion has occurred yet this session.
    today_promote_last_ms: dict[str, int] = Field(default_factory=dict)


@dataclass
class _State:
    """In-process state of the live poller. Mutated only via this module."""

    started_at_ms: int | None = None
    watchlist_codes: tuple[str, ...] = field(default_factory=tuple)
    poller_task: Optional[asyncio.Task] = None  # type: ignore[type-arg]
    # Reference to the underlying poller so get_status can read its counters.
    # Typed as `object` here to avoid circular import with poller.py; the few
    # call sites that need the concrete type can isinstance-check.
    poller_obj: object | None = None


_state = _State()
_buffer = LiveBuffer()

# ADR-0043 / design-review B2 — in-memory dict of code → last successful
# Today Promotion epoch_ms. Populated by promote_today via
# record_today_promote_success; surfaced via LiveStatus.
_today_promote_last_ms: dict[str, int] = {}


def record_today_promote_success(code: str, t_ms: int) -> None:
    """Called by promote_today on success; surfaced via LiveStatus (ADR-0043)."""
    _today_promote_last_ms[code] = t_ms


def get_today_promote_last_ms() -> dict[str, int]:
    """Snapshot of last successful Today Promotion epoch_ms per code."""
    return dict(_today_promote_last_ms)


def get_active_codes() -> list[str]:
    """Return currently active watchlist codes the poller is iterating.

    Empty list if the poller hasn't started or has stopped.

    Contract (eng-review Blocker 2): readers receive a snapshot at call time —
    `_state.watchlist_codes` is read synchronously. `start_today_promoter`
    (ADR-0043) calls this each cycle (every `interval_s` seconds), so
    watchlist mutations through `start_live_poller` (which rebuilds `_state`)
    propagate immediately to the next cycle — no caching, no stale closure.

    If the watchlist changes mid-cycle and you don't want to wait, call
    `start_live_poller` again — it's idempotent and restarts the poller task.
    """
    return list(_state.watchlist_codes)


def get_buffer() -> LiveBuffer:
    return _buffer


def _now_ms() -> int:
    return int(time.time() * 1000)


def get_status() -> LiveStatus:
    """Read the current live status. Always safe to call."""
    running = _state.started_at_ms is not None
    return LiveStatus(
        running=running,
        started_at_ms=_state.started_at_ms,
        last_tick_ms=_read_poller_attr("last_tick_ms"),
        cycle_lag_ms=_read_poller_attr("last_cycle_lag_ms") or 0,
        watchlist_count=len(_state.watchlist_codes),
        kis_calls_today=_read_poller_attr("kis_calls_today") or 0,
        kis_rate_limit_remaining=None,  # KIS doesn't expose this header
        today_promote_last_ms=get_today_promote_last_ms(),
    )


def _read_poller_attr(name: str) -> int | None:
    p = _state.poller_obj
    if p is None:
        return None
    return getattr(p, name, None)


def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state, _buffer
    if _state.poller_task is not None and not _state.poller_task.done():
        _state.poller_task.cancel()
    _state = _State()
    _buffer = LiveBuffer()
    kis_runtime.reset_for_tests()
    _today_promote_last_ms.clear()


async def start_today_promoter(
    *,
    data_dir: Path,
    get_active_codes: Callable[[], list[str]],
    interval_s: float = 300.0,
) -> asyncio.Task:
    """Start the ADR-0043 Today Promotion loop.

    Polls `get_active_codes()` each `interval_s` seconds and calls
    `promote_today(data_dir, code=...)` for each. Per-code exceptions
    are caught and logged so one bad code doesn't break the cycle.
    The outer try/except prevents the loop itself from dying on a
    transient get_active_codes failure.

    Returns the created asyncio.Task; caller (lifespan) is responsible
    for cancelling on shutdown via `stop_today_promoter`.
    """
    log = logging.getLogger(__name__)

    async def loop() -> None:
        while True:
            try:
                codes = get_active_codes()
                for code in codes:
                    try:
                        await promote_today(data_dir, code=code)
                    except Exception:
                        log.exception(
                            "live.today_promote.code_failed code=%s", code,
                        )
            except Exception:
                log.exception("live.today_promote.cycle_failed")
            await asyncio.sleep(interval_s)

    return asyncio.create_task(loop(), name="today-promoter")


async def stop_today_promoter(task: asyncio.Task | None) -> None:
    """Cancel the Today Promoter task and await its completion."""
    if task is None or task.done():
        return
    task.cancel()
    try:
        await task
    except asyncio.CancelledError:
        pass


async def start_live_poller(*, data_dir: Path) -> bool:
    """Start the Live Capture poller singleton.

    Returns True if started successfully, False if preconditions weren't met
    (missing KIS creds, empty watchlist). Subsequent calls to get_status()
    will reflect the running state.

    Idempotent: calling when already running stops the current task and
    starts a fresh one. Watchlist changes are propagated immediately by
    ``refresh_live_poller`` (below), which the add/remove watchlist routes
    call after mutating — that is the auto-restart that was formerly deferred.
    """
    import os
    from datetime import datetime, timedelta, timezone

    from hoga.api.watchlist import load_watchlist

    from .poller import LivePoller, LivePollerConfig
    from .writer import LiveWriter

    app_key = os.environ.get("KIS_APP_KEY")
    app_secret = os.environ.get("KIS_APP_SECRET")
    if not app_key or not app_secret:
        return False

    entries = load_watchlist(data_dir)
    codes = [e.code for e in entries]
    if not codes:
        return False

    # Filter against the symbol master so codes that aren't (or are no longer)
    # listed don't reach KIS — those calls 5xx and drown the error log in noise
    # that masks real failures. Cold cache → fall back to unfiltered polling
    # rather than silently halt capture for everyone.
    from hoga.api import symbols as _symbols
    _known = {h.code for h in _symbols.search("", limit=10_000)}
    if _known:
        _dropped = [c for c in codes if c not in _known]
        if _dropped:
            _log.warning("live.poller.codes_unknown dropped=%r", _dropped)
        codes = [c for c in codes if c in _known]
        if not codes:
            return False

    # If already running, stop first.
    await stop_live_poller()

    # Obtain the PROCESS-singleton KisClient (shared 15/s token bucket) via the
    # single env→creds→path resolver — the same one the screener EOD update and
    # the /quotes route use. Decoupled from poller start/stop: the singleton is
    # reused if already set, so a stop→start cycle never creates a 2nd bucket.
    kis = kis_runtime.ensure_kis_client_from_env(data_dir)
    if kis is None:  # creds vanished after the early guard above
        return False
    writer = LiveWriter(data_dir / "live")

    def _today_kst() -> str:
        return datetime.now(timezone(timedelta(hours=9))).strftime("%Y%m%d")

    cfg = LivePollerConfig(codes_fn=lambda: codes, date_fn=_today_kst)
    poller = LivePoller(kis, writer, cfg, buffer=_buffer)

    # Wire into global state
    global _state
    _state = _State(
        started_at_ms=_now_ms(),
        watchlist_codes=tuple(codes),
        poller_task=asyncio.create_task(poller.run_forever(), name="live-poller"),
        poller_obj=poller,
    )
    return True


async def refresh_live_poller(*, data_dir: Path) -> None:
    """Re-sync the running poller to the on-disk watchlist after a mutation.

    Non-empty watchlist → ``start_live_poller`` (idempotent restart that rebuilds
    ``_state`` from disk and *reuses* the module-global ``_buffer``, preserving
    accumulated snapshots). Empty watchlist → ``stop_live_poller`` — calling
    ``start_live_poller`` alone would early-return on the empty check *before* it
    stops the existing task, leaving a stale poller iterating the old codes.

    Cheap: no awaited network round-trip; ``KisClient`` reuses the on-disk token
    cache. Off-hours/missing-creds are safe (start no-ops/idle-gates; stop is a
    no-op when nothing runs).
    """
    from hoga.api.watchlist import load_watchlist

    if load_watchlist(data_dir):
        await start_live_poller(data_dir=data_dir)
    else:
        await stop_live_poller()


async def stop_live_poller() -> None:
    """Stop the running poller. No-op if already stopped.

    Does NOT touch the KisClient singleton: the shared 15/s token bucket is a
    PROCESS singleton (see ``ensure_kis_client``) that must survive a poller
    stop so the screener's EOD update can reuse it and no second bucket is ever
    created. The httpx client is closed only at process shutdown, via
    ``aclose_kis_client`` (wired into the app's lifespan ``finally``).
    """
    global _state
    if _state.poller_task is not None:
        _state.poller_task.cancel()
        try:
            await _state.poller_task
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            pass  # don't let a buggy poller block shutdown
    _state = _State()
