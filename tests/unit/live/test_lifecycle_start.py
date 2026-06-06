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


@pytest.mark.asyncio
async def test_lifespan_starts_and_stops_poller_gracefully(tmp_path: Path, monkeypatch) -> None:
    """The FastAPI lifespan integrates start_live_stream + stop_live_stream.

    Task 11: lifespan was switched from poller to stream path.  The WS gate
    (ws_capture_window) is deterministically forced closed so KisWsClient.run
    sleeps instead of attempting a real approval-key fetch — the test is
    therefore safe to run at any day/time without network access.
    """
    import json
    from fastapi.testclient import TestClient

    from hoga.api.app import create_app
    from hoga.live import lifecycle, session_gate

    # Force the WS gate closed: ws_capture_window → should_run_now → False.
    # This makes KisWsClient.run sleep(30) in its gate loop instead of calling
    # kis.get_approval_key(), keeping the test network-free regardless of wall
    # clock (the gate is nondeterministic on a weekday trading-hours grader run).
    monkeypatch.setattr(session_gate, "should_run_now", lambda _t: False)

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

    app = create_app(tmp_path)
    with TestClient(app) as c:
        r = c.get("/api/live/status")
        assert r.status_code == 200
        # With creds + watchlist, stream should be running (tasks spawned)
        assert r.json()["running"] is True
        assert r.json()["watchlist_count"] == 1

    # After TestClient exits, lifespan finally ran — stream should be stopped
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_start_live_poller_filters_codes_unknown_to_symbol_master(
    tmp_path: Path, monkeypatch, caplog
) -> None:
    """Codes not in the symbol master are dropped before reaching KIS.

    Prevents HTTP_500 storms on the live poller from non-stock codes
    (warrants, ELW, delisted) silently sitting in the watchlist.
    """
    import json
    import logging

    from hoga.api import symbols
    from hoga.api.models import SymbolHit
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101", "last_success_date": None},
            {"code": "489790", "name": "X",
             "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }))
    # Seed symbol master with only 005930 — 489790 should be filtered out.
    monkeypatch.setattr(symbols, "_cache", [SymbolHit(
        code="005930", name="삼성전자", market="KOSPI",
        captured_count=0, captured_breakdown={},
    )])

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    with caplog.at_level(logging.WARNING, logger="hoga.live.lifecycle"):
        result = await lifecycle.start_live_poller(data_dir=tmp_path)
    assert result is True
    assert lifecycle.get_status().watchlist_count == 1
    assert any("489790" in r.message and "codes_unknown" in r.message
               for r in caplog.records)
    await lifecycle.stop_live_poller()


@pytest.mark.asyncio
async def test_start_live_poller_cold_cache_polls_all_codes(
    tmp_path: Path, monkeypatch
) -> None:
    """If the symbol-master cache is cold, fall back to unfiltered polling.

    Cache failures must not silently halt capture for everyone — losing live
    data is worse than a transient bout of HTTP_500 noise from a stale code.
    """
    import json

    from hoga.api import symbols
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "489790", "name": "X",
             "registered_at_kst_date": "20260101", "last_success_date": None},
        ],
    }))
    monkeypatch.setattr(symbols, "_cache", [])  # cold cache

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    result = await lifecycle.start_live_poller(data_dir=tmp_path)
    assert result is True
    assert lifecycle.get_status().watchlist_count == 1  # 489790 was NOT filtered
    await lifecycle.stop_live_poller()


@pytest.mark.asyncio
async def test_refresh_live_poller_picks_up_new_codes(tmp_path: Path, monkeypatch) -> None:
    """refresh after a watchlist mutation re-syncs the poller's tracked codes."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    def write_wl(codes: list[str]) -> None:
        (tmp_path / "watchlist.json").write_text(json.dumps({
            "version": 1,
            "entries": [
                {"code": c, "name": c, "registered_at_kst_date": "20260101",
                 "last_success_date": None} for c in codes
            ],
        }))

    write_wl(["005930"])
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_active_codes() == ["005930"]

    write_wl(["005930", "000660"])
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert set(lifecycle.get_active_codes()) == {"005930", "000660"}
    await lifecycle.stop_live_poller()


@pytest.mark.asyncio
async def test_refresh_live_poller_stops_on_empty(tmp_path: Path, monkeypatch) -> None:
    """Removing the last code must STOP the poller (start alone early-returns
    without stopping, leaving a stale poller on the old codes)."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "005930", "name": "삼성전자",
                     "registered_at_kst_date": "20260101", "last_success_date": None}],
    }))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_status().running is True

    # Simulate "removed the last entry".
    (tmp_path / "watchlist.json").write_text(json.dumps({"version": 1, "entries": []}))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_status().running is False


@pytest.mark.asyncio
async def test_refresh_live_poller_preserves_buffer(tmp_path: Path, monkeypatch) -> None:
    """A refresh must not swap out the snapshot buffer (♥ toggles must not drop
    accumulated live snapshots)."""
    import json
    from hoga.live import lifecycle, poller as poller_module

    lifecycle.reset_for_tests()
    monkeypatch.setenv("KIS_APP_KEY", "K")
    monkeypatch.setenv("KIS_APP_SECRET", "S")

    async def fake_run_forever(self):
        while True:
            await asyncio.sleep(60)
    monkeypatch.setattr(poller_module.LivePoller, "run_forever", fake_run_forever)

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [{"code": "005930", "name": "삼성전자",
                     "registered_at_kst_date": "20260101", "last_success_date": None}],
    }))
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    buf_before = lifecycle.get_buffer()
    await lifecycle.refresh_live_poller(data_dir=tmp_path)
    assert lifecycle.get_buffer() is buf_before
    await lifecycle.stop_live_poller()
