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


@pytest.mark.asyncio
async def test_catchup_reconciles_marker_from_disk(tmp_path: Path):
    """Existing entries whose data was on disk before registration get
    their last_success_date advanced to match the disk on startup —
    fixes the original "마지막 성공: 아직 없음" bug for code 098460 etc.

    Forces the bug scenario by saving an entry with last_success_date=None
    even though the disk has data through 20260524, then runs _catchup_run
    and asserts the marker advanced.
    """
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    # Stage: user registered 098460 when its marker was None (old-bug scenario).
    forced = [WatchlistEntry(
        code="098460", name="고영",
        registered_at_kst_date="20260527",
        last_success_date=None,
    )]
    watchlist.save_watchlist(tmp_path, entries=forced)

    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date",
               return_value="20260524"), \
         patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])):
        await scheduler._catchup_run(tmp_path)

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260524"


@pytest.mark.asyncio
async def test_catchup_reconcile_is_noop_when_disk_has_nothing(tmp_path: Path):
    """Empty parquet root (typical fresh tmp_path) → reconcile bumps
    nothing, preserves null markers and existing catch-up behavior."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)
    # Note: NOT patching latest_complete_date — real call must return None
    # because tmp_path/parquet doesn't exist.
    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260521"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])):
        await scheduler._catchup_run(tmp_path)

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date is None


@pytest.mark.asyncio
async def test_catchup_reconcile_does_not_regress_marker(tmp_path: Path):
    """If the disk's latest COMPLETE is older than the entry's current
    marker, reconcile must not regress (bump_last_success is monotonic)."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260525")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.latest_complete_date",
               return_value="20260522"), \
         patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])):
        await scheduler._catchup_run(tmp_path)

    [entry] = watchlist.load_watchlist(tmp_path)
    assert entry.last_success_date == "20260525"  # not regressed to 20260522


@pytest.mark.asyncio
async def test_start_scheduler_spawns_catchup_and_daily_loop(tmp_path: Path):
    import asyncio
    from hoga.api import scheduler

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()
        await asyncio.sleep(3600)  # stay alive so cancel() raises

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)  # never fire in this test

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(catchup_called.wait(), timeout=1.0)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t


@pytest.mark.asyncio
async def test_catchup_one_entry_returns_empty_when_no_gap(tmp_path: Path):
    """When last_success >= today, returns empty EnqueueResponse without calling enqueue."""
    from hoga.api import scheduler
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date="20260526",
    )
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert isinstance(result, EnqueueResponse)
    assert result.enqueued == [] and result.deduped == []
    assert enq.await_count == 0


@pytest.mark.asyncio
async def test_catchup_one_entry_reconciles_then_backfills(tmp_path: Path):
    """If disk has newer COMPLETE date, marker advances first, then backfill uses new floor."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    await watchlist.add_entry(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    # Persisted entry has last_success_date=None (but add_entry might have seeded it
    # from the disk-reconcile flow; for this test we pass the entry with None
    # directly).
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date=None,
    )
    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date",
               return_value="20260524"), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526", "20260527"]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    # bump_last_success was called with date=20260524
    entries = watchlist.load_watchlist(tmp_path)
    assert entries[0].last_success_date == "20260524"
    # trading_days_in_range called from next_day(20260524) = 20260525.
    enq.assert_awaited_once()
    call_req = enq.await_args.kwargs.get("req") or enq.await_args.args[0]
    assert call_req.dates == ["20260525", "20260526", "20260527"]
    assert isinstance(result, EnqueueResponse)


@pytest.mark.asyncio
async def test_catchup_one_entry_q14_trim(tmp_path: Path):
    """Today is pre-trimmed via find_ineligible_dates."""
    from hoga.api import scheduler
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date="20260524",
    )
    fake_now = dt.datetime(2026, 5, 27, 10, 0, 0, tzinfo=KST)  # before 18
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260525", "20260526", "20260527"]), \
         patch("hoga.api.scheduler.find_ineligible_dates",
               return_value=["20260527"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    call_req = enq.await_args.kwargs.get("req") or enq.await_args.args[0]
    assert call_req.dates == ["20260525", "20260526"]


@pytest.mark.asyncio
async def test_catchup_one_entry_returns_empty_on_krx_unavailable(tmp_path: Path):
    """KrxUnavailableError → empty response, no enqueue."""
    from hoga.api import scheduler
    from hoga.api.calendar import KrxUnavailableError
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import WatchlistEntry
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date=None,
    )
    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    def boom(*args, **kwargs):
        raise KrxUnavailableError(UpstreamCode.KRX_CREDENTIALS_MISSING)
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range", side_effect=boom), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert result.enqueued == [] and result.deduped == []
    assert enq.await_count == 0
