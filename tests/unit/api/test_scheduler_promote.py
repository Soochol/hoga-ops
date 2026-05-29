"""Stage 8.1 — scheduler _daily_run calls promote_pending before enqueue."""
import datetime as dt
import json
from pathlib import Path
from unittest.mock import AsyncMock, patch

import pytest


@pytest.mark.asyncio
async def test_daily_run_calls_promote_before_enqueue(tmp_path: Path) -> None:
    """Promotion must happen first so kis_live data is on disk when hogaplay
    enqueue starts the same day."""
    from hoga.api.scheduler import _daily_run

    call_order: list[str] = []

    async def fake_promote(d: Path) -> None:
        call_order.append("promote")

    async def fake_cleanup(d: Path) -> None:
        call_order.append("cleanup")

    async def fake_enqueue(req, *, data_dir, now):
        call_order.append("enqueue")

    # Empty watchlist — _daily_run will still call promote, but the
    # enqueue loop body won't fire. To force the enqueue branch, add a
    # watchlist entry below.
    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101",
             "last_success_date": None},
        ],
    }))

    # _daily_run consults trading_days_in_range; patch it to claim today is a trading day.
    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y%m%d")

    with patch("hoga.live.promote.promote_pending", new=fake_promote), \
         patch("hoga.live.promote.cleanup_archive", new=fake_cleanup), \
         patch("hoga.api.scheduler.enqueue_items_core", new=fake_enqueue), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value={today}):
        await _daily_run(tmp_path)

    # promote + cleanup happen BEFORE enqueue
    assert call_order[:2] == ["promote", "cleanup"]
    assert "enqueue" in call_order
    assert call_order.index("enqueue") > call_order.index("promote")


@pytest.mark.asyncio
async def test_daily_run_continues_when_promote_fails(tmp_path: Path) -> None:
    """A buggy promote must not block hogaplay enqueue."""
    from hoga.api.scheduler import _daily_run

    enqueue_called = []

    async def boom(d: Path) -> None:
        raise RuntimeError("oops")

    async def fake_enqueue(req, *, data_dir, now):
        enqueue_called.append(req)

    (tmp_path / "watchlist.json").write_text(json.dumps({
        "version": 1,
        "entries": [
            {"code": "005930", "name": "삼성전자",
             "registered_at_kst_date": "20260101",
             "last_success_date": None},
        ],
    }))

    today = dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).strftime("%Y%m%d")
    with patch("hoga.live.promote.promote_pending", new=boom), \
         patch("hoga.live.promote.cleanup_archive", new=boom), \
         patch("hoga.api.scheduler.enqueue_items_core", new=fake_enqueue), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value={today}):
        await _daily_run(tmp_path)
    assert enqueue_called, "enqueue should still run even if promote crashes"
