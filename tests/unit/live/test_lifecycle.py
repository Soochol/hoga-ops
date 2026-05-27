"""Stage 7-α — lifecycle singleton."""
from datetime import datetime
from pathlib import Path

import pytest


def test_get_status_returns_not_running_initially() -> None:
    """Before start() is called, status reports running=False with defaults."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    status = lifecycle.get_status()
    assert status.running is False
    assert status.started_at_ms is None
    assert status.last_tick_ms is None
    assert status.cycle_lag_ms == 0
    assert status.watchlist_count == 0
    assert status.kis_calls_today == 0
    assert status.kis_rate_limit_remaining is None


def test_status_reflects_poller_state_after_start(tmp_path: Path) -> None:
    """After start(), status reports running=True with the configured watchlist size."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.start(
        data_dir=tmp_path,
        codes=["005930", "000660"],
        # Skip the actual asyncio task by passing dry_run=True
        dry_run=True,
    )
    status = lifecycle.get_status()
    assert status.running is True
    assert status.watchlist_count == 2
    assert status.started_at_ms is not None and status.started_at_ms > 0
    lifecycle.reset_for_tests()


def test_reset_for_tests_is_idempotent() -> None:
    """Helper for test isolation must be safe to call multiple times."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    lifecycle.reset_for_tests()
    assert lifecycle.get_status().running is False
