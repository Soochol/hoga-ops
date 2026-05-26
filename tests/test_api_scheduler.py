"""Scheduler unit tests. See spec 2026-05-26 + ADR-0034."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import pytest


KST = ZoneInfo("Asia/Seoul")


def _at(h: int, m: int = 0, day: int = 26) -> dt.datetime:
    return dt.datetime(2026, 5, day, h, m, 0, tzinfo=KST)


def test_before_18_returns_today_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(17, 59))
    assert 50 < secs < 70


def test_at_exactly_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 0))
    assert secs == pytest.approx(24 * 3600, abs=2)


def test_after_18_returns_tomorrow_18():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(18, 1))
    # 23h 59m to tomorrow's 18:00.
    assert 23 * 3600 + 59 * 60 - 2 < secs < 23 * 3600 + 59 * 60 + 2


def test_midnight_returns_18h():
    from hoga.api.scheduler import seconds_until_next_18_kst
    secs = seconds_until_next_18_kst(_at(0, 0))
    assert secs == pytest.approx(18 * 3600, abs=2)


@pytest.mark.asyncio
async def test_daily_run_enqueues_each_watchlist_entry_on_trading_day(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)  # Tuesday

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._daily_run(tmp_path)

    # Two calls — one per Watchlist entry.
    assert enq.await_count == 2
    codes = sorted(c.kwargs["req"].code if "req" in c.kwargs
                   else c.args[0].code for c in enq.await_args_list)
    assert codes == ["003490", "005930"]


@pytest.mark.asyncio
async def test_daily_run_skips_non_trading_day(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 24, 18, 0, 0, tzinfo=KST)  # Sunday

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._daily_run(tmp_path)

    assert enq.await_count == 0


@pytest.mark.asyncio
async def test_daily_run_per_entry_failure_does_not_abort_loop(tmp_path: Path):
    """One bad entry must not stop later entries from being enqueued."""
    from fastapi import HTTPException
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.add_entry(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)

    async def flaky(req, *, data_dir, now):
        if req.code == "003490":
            raise HTTPException(status_code=503,
                                detail={"code": "krx_credentials_missing"})
        from hoga.api.models import EnqueueResponse
        return EnqueueResponse(enqueued=[], deduped=[])

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               side_effect=flaky) as enq:
        await scheduler._daily_run(tmp_path)

    assert enq.await_count == 2  # Both attempted despite the first failing.


@pytest.mark.asyncio
async def test_catchup_enqueues_gap_since_last_success(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)  # after 18

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    assert enq.await_count == 1
    call_req = enq.await_args.kwargs["req"] if "req" in enq.await_args.kwargs else enq.await_args.args[0]
    assert call_req.code == "003490"
    assert call_req.dates == ["20260525", "20260526"]


@pytest.mark.asyncio
async def test_catchup_pretrims_today_when_too_early(tmp_path: Path):
    """When now < 18:00, today must be removed before calling core."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, 0, tzinfo=KST)  # before 18

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    call_req = enq.await_args.kwargs["req"] if "req" in enq.await_args.kwargs else enq.await_args.args[0]
    assert call_req.dates == ["20260525"]


@pytest.mark.asyncio
async def test_catchup_uses_registered_at_when_no_last_success(tmp_path: Path):
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260521", "20260522"]) as trading, \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    # next_kst_day(20260520) = 20260521
    trading.assert_called_with("20260521", "20260526")
    assert enq.await_count == 1


@pytest.mark.asyncio
async def test_catchup_skips_entry_with_empty_range(tmp_path: Path):
    """If last_success >= today, the gap is empty — no enqueue."""
    from hoga.api import scheduler, watchlist
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._catchup_run(tmp_path)
    # Gap is [next_day(20260526)=20260527 .. 20260526] which is empty.
    assert enq.await_count == 0
