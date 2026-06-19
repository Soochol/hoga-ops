from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

from fastapi.testclient import TestClient


def test_app_startup_scheduler_does_not_spawn_catchup_by_default(
    tmp_path: Path,
    monkeypatch,
):
    from hoga.api import app as app_mod
    from hoga.api import scheduler as scheduler_mod

    task_names: list[str] = []

    async def fake_daily_loop(data_dir):
        await asyncio.sleep(3600)

    async def fake_catchup(data_dir):
        raise AssertionError("startup catch-up must not run by default")

    original_create_task = asyncio.create_task
    start_live_stream = AsyncMock(return_value=True)
    start_live_stream_watchdog = AsyncMock(return_value=None)
    start_today_promoter = AsyncMock(return_value=None)

    def tracking_create_task(coro, *, name=None, context=None):
        if name is not None:
            task_names.append(name)
        return original_create_task(coro, name=name, context=context)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)
    monkeypatch.delenv("HOGA_LIVE_STARTUP_ENABLED", raising=False)
    monkeypatch.setattr(scheduler_mod, "_daily_loop", fake_daily_loop)
    monkeypatch.setattr(scheduler_mod, "_catchup_run", fake_catchup)
    monkeypatch.setattr(app_mod._symbols_module, "needs_boot_refresh", lambda: False)
    monkeypatch.setattr(app_mod, "start_live_stream", start_live_stream)
    monkeypatch.setattr(app_mod, "start_live_stream_watchdog", start_live_stream_watchdog)
    monkeypatch.setattr(app_mod, "start_today_promoter", start_today_promoter)
    monkeypatch.setattr(asyncio, "create_task", tracking_create_task)

    with TestClient(app_mod.create_app(tmp_path)) as client:
        assert client.get("/health").status_code == 200

    assert start_live_stream.await_count == 0
    assert "watchlist-daily-loop" in task_names
    assert "watchlist-catchup" not in task_names


def test_app_startup_can_opt_into_live_startup(
    tmp_path: Path,
    monkeypatch,
):
    from hoga.api import app as app_mod
    from hoga.api import scheduler as scheduler_mod

    task_names: list[str] = []

    async def fake_daily_loop(data_dir):
        await asyncio.sleep(3600)

    async def fake_catchup(data_dir):
        raise AssertionError("startup catch-up must not run by default")

    original_create_task = asyncio.create_task
    start_live_stream = AsyncMock(return_value=True)
    start_live_stream_watchdog = AsyncMock(return_value=None)
    start_today_promoter = AsyncMock(return_value=None)

    def tracking_create_task(coro, *, name=None, context=None):
        if name is not None:
            task_names.append(name)
        return original_create_task(coro, name=name, context=context)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)
    monkeypatch.setenv("HOGA_LIVE_STARTUP_ENABLED", "true")
    monkeypatch.setattr(scheduler_mod, "_daily_loop", fake_daily_loop)
    monkeypatch.setattr(scheduler_mod, "_catchup_run", fake_catchup)
    monkeypatch.setattr(app_mod._symbols_module, "needs_boot_refresh", lambda: False)
    monkeypatch.setattr(app_mod, "start_live_stream", start_live_stream)
    monkeypatch.setattr(app_mod, "start_live_stream_watchdog", start_live_stream_watchdog)
    monkeypatch.setattr(app_mod, "start_today_promoter", start_today_promoter)
    monkeypatch.setattr(asyncio, "create_task", tracking_create_task)

    with TestClient(app_mod.create_app(tmp_path)) as client:
        assert client.get("/health").status_code == 200

    assert start_live_stream.await_count == 1
    assert "watchlist-daily-loop" in task_names
    assert "watchlist-catchup" not in task_names
