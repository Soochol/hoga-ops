import asyncio
import datetime as dt
import json
from unittest.mock import AsyncMock
from zoneinfo import ZoneInfo

import pytest

from hoga.api import scheduler
from hoga.api.models import EnqueueResponse

NOW = dt.datetime(2026, 9, 10, 18, tzinfo=ZoneInfo("Asia/Seoul"))


async def test_failed_registration_survives_restart_and_retries_only_failed_code(tmp_path, monkeypatch):
    success = EnqueueResponse(enqueued=[], deduped=[])
    enqueue = AsyncMock(side_effect=[success, RuntimeError("temporary failure"), success])
    monkeypatch.setattr(scheduler, "enqueue_items_core", enqueue)
    await scheduler._enqueue_daily_codes(tmp_path, ["005930", "000660"], now=NOW)
    assert json.loads(scheduler._pending_enqueues_path(tmp_path).read_text())["codes"] == ["000660"]
    # Retry reads the durable checkpoint, without depending on the earlier invocation's locals.
    await scheduler.retry_pending_enqueues(tmp_path, now=NOW)
    await scheduler.retry_pending_enqueues(tmp_path, now=NOW)
    assert [c.args[0].code for c in enqueue.await_args_list] == ["005930", "000660", "000660"]
    assert json.loads(scheduler._pending_enqueues_path(tmp_path).read_text())["codes"] == []


async def test_policy_block_is_settled_and_expired_failures_are_not_enqueued(tmp_path, monkeypatch):
    blocked = EnqueueResponse(enqueued=[], deduped=[], blocked=[{
        "code": "005930", "date": "20260910", "fail_streak": 3, "reason": "fail_streak_exceeded",
    }])
    enqueue = AsyncMock(return_value=blocked)
    monkeypatch.setattr(scheduler, "enqueue_items_core", enqueue)
    await scheduler._enqueue_daily_codes(tmp_path, ["005930"], now=NOW)
    await scheduler.retry_pending_enqueues(tmp_path, now=NOW)
    scheduler._save_pending_enqueues(tmp_path, "20260909", ["000660"])
    await scheduler.retry_pending_enqueues(tmp_path, now=NOW)
    assert enqueue.await_count == 1


async def test_daily_loop_retries_failed_registration_without_repeating_maintenance(tmp_path, monkeypatch):
    scheduler.write_last_daily_run_date(tmp_path, "20260910")
    scheduler.write_last_trading_stage_date(tmp_path, "20260910")
    scheduler._save_pending_enqueues(tmp_path, "20260910", ["005930"])
    enqueue = AsyncMock(return_value=EnqueueResponse(enqueued=[], deduped=[]))
    monkeypatch.setattr(scheduler, "enqueue_items_core", enqueue)
    monkeypatch.setattr(scheduler, "now_kst", lambda: NOW)
    daily, stage = AsyncMock(), AsyncMock()
    monkeypatch.setattr(scheduler, "_daily_run", daily)
    monkeypatch.setattr(scheduler, "run_trading_stage", stage)
    monkeypatch.setattr(scheduler.asyncio, "sleep", AsyncMock(side_effect=asyncio.CancelledError))
    with pytest.raises(asyncio.CancelledError):
        await scheduler._daily_loop(tmp_path)
    assert enqueue.await_count == 1
    daily.assert_not_awaited()
    stage.assert_not_awaited()


async def test_cancellation_keeps_unsettled_entries_for_recovery(tmp_path, monkeypatch):
    enqueue = AsyncMock(side_effect=[EnqueueResponse(enqueued=[], deduped=[]), asyncio.CancelledError])
    monkeypatch.setattr(scheduler, "enqueue_items_core", enqueue)
    with pytest.raises(asyncio.CancelledError):
        await scheduler._enqueue_daily_codes(tmp_path, ["005930", "000660"], now=NOW)
    assert json.loads(scheduler._pending_enqueues_path(tmp_path).read_text())["codes"] == ["000660"]
