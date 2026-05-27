"""Live Capture lifecycle singleton.

Owns the single in-process LivePoller instance and exposes a stable
`get_status()` callable for the API layer. Stage 8 will wire `start()`
into FastAPI's lifespan; Stage 7-α only needs the module to be queryable
so `/api/live/status` can return defaults before the poller starts.

Single-worker invariant: see ADR-0038. The module-level singleton is
safe because hoga/live/__init__.py asserts UVICORN_WORKERS == 1 at
import time.
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from pydantic import BaseModel


class LiveStatus(BaseModel):
    """Wire model for GET /api/live/status (spec §6)."""

    running: bool
    started_at_ms: int | None
    last_tick_ms: int | None
    cycle_lag_ms: int
    watchlist_count: int
    kis_calls_today: int
    kis_rate_limit_remaining: int | None


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


def _now_ms() -> int:
    return int(time.time() * 1000)


def start(
    *,
    data_dir: Path,
    codes: list[str],
    dry_run: bool = False,
) -> None:
    """Start (or replace) the live poller singleton.

    Stage 7-α: when `dry_run=True`, skip creating the actual asyncio
    task — useful for unit tests and for /api/live/status to report
    a running state without consuming KIS quota. Stage 8 will wire the
    real start path through FastAPI's lifespan.
    """
    global _state
    _state = _State(
        started_at_ms=_now_ms(),
        watchlist_codes=tuple(codes),
        poller_task=None,  # Stage 8 will populate
        poller_obj=None,
    )
    if dry_run:
        return
    # Real start path is wired in Stage 8. Stage 7-α stub keeps the API
    # endpoint functional without spinning real network traffic.
    raise NotImplementedError(
        "lifecycle.start() with dry_run=False is implemented in Stage 8 "
        "(lifespan + scheduler integration)."
    )


def stop() -> None:
    """Stop the running poller (no-op if already stopped)."""
    global _state
    if _state.poller_task is not None and not _state.poller_task.done():
        _state.poller_task.cancel()
    _state = _State()


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
    )


def _read_poller_attr(name: str) -> int | None:
    p = _state.poller_obj
    if p is None:
        return None
    return getattr(p, name, None)


def reset_for_tests() -> None:
    """Test-only hook. Resets module state without raising."""
    global _state
    if _state.poller_task is not None and not _state.poller_task.done():
        _state.poller_task.cancel()
    _state = _State()
