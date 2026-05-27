"""Stage 8.2 — start_live_poller + stop_live_poller integration."""
import asyncio
import os
from pathlib import Path
from unittest.mock import patch

import pytest


@pytest.mark.asyncio
async def test_start_live_poller_returns_falsy_when_creds_missing(tmp_path: Path, monkeypatch) -> None:
    """Without KIS_APP_KEY/SECRET, poller stays off."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.delenv("KIS_APP_KEY", raising=False)
    monkeypatch.delenv("KIS_APP_SECRET", raising=False)

    result = await lifecycle.start_live_poller(data_dir=tmp_path)
    assert result is False
    status = lifecycle.get_status()
    assert status.running is False


@pytest.mark.asyncio
async def test_start_live_poller_returns_falsy_when_watchlist_empty(tmp_path: Path, monkeypatch) -> None:
    """With creds but empty watchlist, poller stays off."""
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    # Empty watchlist (no watchlist.json file)
    result = await lifecycle.start_live_poller(data_dir=tmp_path)
    assert result is False
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_start_live_poller_starts_task_with_creds_and_watchlist(tmp_path: Path, monkeypatch) -> None:
    """With creds AND non-empty watchlist, poller starts."""
    import json
    from hoga.live import lifecycle

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }))

    # Patch the run_forever loop so we don't make real HTTP calls
    from hoga.live import poller as poller_module
    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    result = await lifecycle.start_live_poller(data_dir=tmp_path)
    assert result is True
    status = lifecycle.get_status()
    assert status.running is True
    assert status.watchlist_count == 1
    # Cleanup
    await lifecycle.stop_live_poller()
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_stop_live_poller_is_idempotent(tmp_path: Path) -> None:
    from hoga.live import lifecycle
    lifecycle.reset_for_tests()
    # Stop without start — no-op, no error
    await lifecycle.stop_live_poller()
    await lifecycle.stop_live_poller()
    assert lifecycle.get_status().running is False
