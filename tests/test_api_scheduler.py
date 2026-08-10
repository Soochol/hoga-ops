"""Scheduler unit tests. See spec 2026-05-26 + ADR-0034."""
from __future__ import annotations

import datetime as dt
from pathlib import Path
from unittest.mock import AsyncMock, patch
from zoneinfo import ZoneInfo

import pytest

KST = ZoneInfo("Asia/Seoul")


async def _seed(tmp_path, *, code: str, name: str, today_kst_date: str):
    """v3 seed (add_entry 폐지): ensure a '기본' folder, add the code as a member."""
    from hoga.api.watchlist import add_member, create_folder, load_document
    doc = load_document(tmp_path)
    fid = doc.folders[0].id if doc.folders else (await create_folder(tmp_path, name="기본")).id
    return await add_member(tmp_path, code=code, name=name,
                            today_kst_date=today_kst_date, folder_id=fid)


def _at(h: int, m: int = 0, day: int = 26) -> dt.datetime:
    return dt.datetime(2026, 5, day, h, m, 0, tzinfo=KST)


def test_before_17_returns_today_17():
    from hoga.api.scheduler import seconds_until_next_17_kst
    secs = seconds_until_next_17_kst(_at(16, 59))
    assert 50 < secs < 70


def test_at_exactly_17_returns_tomorrow_17():
    from hoga.api.scheduler import seconds_until_next_17_kst
    secs = seconds_until_next_17_kst(_at(17, 0))
    assert secs == pytest.approx(24 * 3600, abs=2)


def test_after_17_returns_tomorrow_17():
    from hoga.api.scheduler import seconds_until_next_17_kst
    secs = seconds_until_next_17_kst(_at(17, 1))
    # 23h 59m to tomorrow's 17:00.
    assert 23 * 3600 + 59 * 60 - 2 < secs < 23 * 3600 + 59 * 60 + 2


def test_midnight_returns_17h():
    from hoga.api.scheduler import seconds_until_next_17_kst
    secs = seconds_until_next_17_kst(_at(0, 0))
    assert secs == pytest.approx(17 * 3600, abs=2)


@pytest.mark.asyncio
async def test_daily_run_enqueues_each_watchlist_entry_on_trading_day(tmp_path: Path):
    from hoga.api import scheduler
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await _seed(tmp_path, code="005930", name="삼성전자",
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
    from hoga.api import scheduler
    await _seed(tmp_path, code="003490", name="대한항공",
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

    from hoga.api import scheduler
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await _seed(tmp_path, code="005930", name="삼성전자",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)

    async def flaky(req, *, data_dir, now):
        if req.code == "003490":
            raise HTTPException(status_code=503,
                                detail={"code": "trading_days_unavailable"})
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
async def test_daily_run_logs_blocked_watchlist_date(tmp_path: Path, caplog):
    """ADR-0042 amendment: when the fail_streak cap blocks a Watchlist date, the
    daily sweep must log it. Otherwise the date (e.g. 180640/20260601 once it hits
    the cap from repeated stagnation_abort) silently drops out of unattended
    capture with no operator signal."""
    import logging

    from hoga.api import scheduler
    from hoga.api.models import BlockedItem, EnqueueResponse
    await _seed(tmp_path, code="180640", name="한진칼",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 18, 0, 0, tzinfo=KST)
    blocked = EnqueueResponse(
        enqueued=[], deduped=[],
        blocked=[BlockedItem(code="180640", date="20260526",
                             fail_streak=5, reason="fail_streak_exceeded")],
    )

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock, return_value=blocked), \
         caplog.at_level(logging.WARNING, logger="hoga.api.scheduler"):
        await scheduler._daily_run(tmp_path)

    blocked_warnings = [
        r for r in caplog.records
        if r.levelno == logging.WARNING
        and "180640" in r.getMessage() and "blocked" in r.getMessage()
    ]
    assert blocked_warnings, \
        "daily run must warn when a Watchlist date is fail_streak-blocked"


@pytest.mark.asyncio
async def test_catchup_enqueues_today_even_when_the_marker_is_days_behind(tmp_path: Path):
    """마커가 4일 뒤처져 있어도 적재 대상은 오늘 하루다 (ADR-0142 당일치기).

    예전 명제는 "마커 다음날부터 오늘까지의 갭을 채운다" 였다. hogaplay 보유가
    ~18시간이라 그 갭의 대부분은 애초에 받을 수 없는 날짜였고, 실패만 쌓았다.
    """
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)  # after 17

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]) as trading, \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    # 마커(20260522)가 아니라 오늘로 캘린더를 묻는다 — 갭을 걷지 않는다.
    trading.assert_called_with("20260526", "20260526")
    assert enq.await_count == 1
    call_req = enq.await_args.kwargs["req"] if "req" in enq.await_args.kwargs else enq.await_args.args[0]
    assert call_req.code == "003490"
    assert call_req.dates == ["20260526"]


@pytest.mark.asyncio
async def test_catchup_pretrims_today_when_too_early(tmp_path: Path):
    """When now < 16:30, today must be removed before calling core."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260522")
    fake_now = dt.datetime(2026, 5, 26, 10, 0, 0, tzinfo=KST)  # before 17

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
async def test_catchup_asks_only_for_today_never_walks_back(tmp_path: Path):
    """ADR-0142: 당일치기. 등록일이 6일 전이어도 캘린더 질의는 오늘 하루뿐이다.

    이 단언이 곧 회귀 방지선이다 — 예전엔 registered_at_kst_date 를 floor 로
    ("20260521", "20260526") 을 물었고, 히트맵 271종목이 같은 경로를 타면 첫 런에서
    큐가 수천 건이 된다(hogaplay 보유 ~18시간 안에 소진 불가).
    """
    from hoga.api import scheduler
    from hoga.api.models import EnqueueResponse
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=["20260526"]) as trading, \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        await scheduler._catchup_run(tmp_path)

    trading.assert_called_with("20260526", "20260526")
    assert enq.await_count == 1
    assert enq.await_args.args[0].dates == ["20260526"]


@pytest.mark.asyncio
async def test_catchup_skips_when_today_is_not_a_trading_day(tmp_path: Path):
    """휴장일이면 적재 대상이 없다 — 캘린더가 빈 목록을 주는 경로.

    ADR-0142 이전에는 "last_success >= today 면 갭이 비어 건너뛴다" 가 이 자리의
    명제였다. 당일치기에서는 마커가 이미 오늘이어도 오늘을 다시 넣는다(중복은 큐의
    dedup 이 흡수한다) — 건너뛰는 유일한 이유가 휴장으로 좁혀졌다.
    """
    from hoga.api import scheduler, watchlist
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260526")
    await watchlist.bump_last_success(tmp_path, code="003490", date="20260526")
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)

    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               return_value=[]), \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._catchup_run(tmp_path)
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
    # v3 불변식: entry 는 폴더 member 여야 save 가 보존(orphan prune, ADR-0070).
    folder = watchlist.WatchlistFolder(id="f_0000000a", name="기본", order=0, member_codes=["098460"])
    watchlist.save_document(tmp_path, watchlist.WatchlistDocument(folders=[folder], entries=forced))

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
    await _seed(tmp_path, code="003490", name="대한항공",
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
async def test_catchup_reconcile_regresses_stale_marker_to_disk_truth(tmp_path: Path):
    """If the disk's latest COMPLETE is older than the entry's current
    marker, reconcile MUST regress to disk truth. The original "monotonic"
    contract treated phase="done" as proof of COMPLETE, which is false for
    abort_reason=stagnation_abort and lenient-fallback INVALID cases — those
    paths bump the marker past the actual latest COMPLETE on disk and leave
    /watchlist and /capture in disagreement. The fix gates the finalize-side
    bump on disk_state (captures._finalize_item) and makes reconcile the
    repair path for any stale-too-high markers left from before the gate."""
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse
    await _seed(tmp_path, code="003490", name="대한항공",
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
    assert entry.last_success_date == "20260522"  # regressed to disk truth


@pytest.mark.asyncio
async def test_start_scheduler_spawns_only_daily_loop_by_default(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import asyncio

    from hoga.api import scheduler

    # 일일 배치는 data_dir 당 한 프로세스이고 **자격이 있을 때만** 락을 잡는다
    # (ADR-0094 확장). 이 스위트가 재는 것은 태스크 구성이지 소유권이 아니므로
    # 자격을 준다 — 소유권 자체는 tests/test_collector_ownership.py 가 다룬다.
    monkeypatch.setattr(scheduler, "_kiwoom_credentialed", lambda *_a, **_k: True)

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()
        await asyncio.sleep(3600)

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        assert catchup_called.is_set() is False
        assert [t.get_name() for t in tasks] == ["watchlist-daily-loop"]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t


@pytest.mark.asyncio
async def test_start_scheduler_can_opt_into_startup_catchup(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    import asyncio

    from hoga.api import scheduler

    # 일일 배치는 data_dir 당 한 프로세스이고 **자격이 있을 때만** 락을 잡는다
    # (ADR-0094 확장). 이 스위트가 재는 것은 태스크 구성이지 소유권이 아니므로
    # 자격을 준다 — 소유권 자체는 tests/test_collector_ownership.py 가 다룬다.
    monkeypatch.setattr(scheduler, "_kiwoom_credentialed", lambda *_a, **_k: True)

    catchup_called = asyncio.Event()
    daily_loop_entered = asyncio.Event()

    async def fake_catchup(data_dir):
        catchup_called.set()
        await asyncio.sleep(3600)

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)

    monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", "true")

    with patch("hoga.api.scheduler._catchup_run", side_effect=fake_catchup), \
         patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(catchup_called.wait(), timeout=1.0)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        assert sorted(t.get_name() for t in tasks) == [
            "watchlist-catchup",
            "watchlist-daily-loop",
        ]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t


@pytest.mark.asyncio
async def test_start_scheduler_can_opt_into_night_futures_keeper(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    """야간 keeper 는 **플래그 + 자격** 둘 다 있어야 뜬다.

    기본 꺼짐은 위 `..._spawns_only_daily_loop_by_default` 의 태스크 목록 단언이 이미
    못박는다(keeper 가 무조건 뜨면 그 목록이 깨진다). 여기서 재는 것은 켰을 때 실제로
    뜨는가와, **무자격이면 켜도 안 뜨는가** 다 — 후자를 빼면 health 에 "도는 중인데
    아무것도 안 하는" 거짓 행이 영원히 남는다(ADR-0134).
    """
    import asyncio

    from hoga.api import scheduler

    # 일일 배치는 data_dir 당 한 프로세스이고 **자격이 있을 때만** 락을 잡는다
    # (ADR-0094 확장). 이 스위트가 재는 것은 태스크 구성이지 소유권이 아니므로
    # 자격을 준다 — 소유권 자체는 tests/test_collector_ownership.py 가 다룬다.
    monkeypatch.setattr(scheduler, "_kiwoom_credentialed", lambda *_a, **_k: True)
    from hoga.live import futures_runtime

    daily_loop_entered = asyncio.Event()
    keeper_entered = asyncio.Event()

    async def fake_daily_loop(data_dir):
        daily_loop_entered.set()
        await asyncio.sleep(3600)

    async def fake_keeper(data_dir, **kwargs):
        keeper_entered.set()
        await asyncio.sleep(3600)

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)
    monkeypatch.setenv("HOGA_NIGHT_FUTURES_KEEPER", "true")
    monkeypatch.setattr(futures_runtime, "run_night_keeper", fake_keeper)

    # 무자격 — 플래그가 켜져 있어도 태스크를 만들지 않는다.
    monkeypatch.setattr(futures_runtime, "is_available", lambda _d: False)
    with patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(daily_loop_entered.wait(), timeout=1.0)
        assert "futures-night-keeper" not in [t.get_name() for t in tasks]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t

    # 자격이 있으면 뜬다.
    daily_loop_entered.clear()
    monkeypatch.setattr(futures_runtime, "is_available", lambda _d: True)
    with patch("hoga.api.scheduler._daily_loop", side_effect=fake_daily_loop):
        tasks = scheduler.start_scheduler(tmp_path)
        await asyncio.wait_for(keeper_entered.wait(), timeout=1.0)
        assert "futures-night-keeper" in [t.get_name() for t in tasks]
        for t in tasks:
            t.cancel()
        for t in tasks:
            with pytest.raises((asyncio.CancelledError, BaseException)):
                await t


def test_startup_catchup_enabled_defaults_to_false(monkeypatch):
    from hoga.api import scheduler

    monkeypatch.delenv("HOGA_STARTUP_CATCHUP_ENABLED", raising=False)

    assert scheduler.startup_catchup_enabled_from_env() is False


def test_startup_catchup_enabled_accepts_true_only(monkeypatch):
    from hoga.api import scheduler

    monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", "true")
    assert scheduler.startup_catchup_enabled_from_env() is True

    for value in ["false", "1", "yes", "", "TRUE "]:
        monkeypatch.setenv("HOGA_STARTUP_CATCHUP_ENABLED", value)
        assert scheduler.startup_catchup_enabled_from_env() is False


@pytest.mark.asyncio
async def test_catchup_one_entry_returns_empty_on_a_holiday(tmp_path: Path):
    """휴장일이면 enqueue 없이 빈 EnqueueResponse (ADR-0142 당일치기)."""
    from hoga.api import scheduler
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260526",
        last_success_date="20260526",
    )
    fake_now = dt.datetime(2026, 5, 26, 19, 0, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert isinstance(result, EnqueueResponse)
    assert result.enqueued == [] and result.deduped == []
    assert enq.await_count == 0


@pytest.mark.asyncio
async def test_catchup_one_entry_reconciles_marker_then_enqueues_today(tmp_path: Path):
    """디스크에 더 최신 COMPLETE 가 있으면 마커가 먼저 그리로 맞춰지고, 적재는 오늘치.

    reconcile 절반은 ADR-0142 이후에도 그대로 남는다 — 결손 표시가 디스크와 어긋나지
    않으려면 필요하다. 사라진 건 그 마커를 floor 로 삼아 갭을 걷던 뒷절반뿐이다.
    """
    from hoga.api import scheduler, watchlist
    from hoga.api.models import EnqueueResponse, WatchlistEntry
    await _seed(tmp_path, code="003490", name="대한항공",
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
               return_value=["20260527"]) as trading, \
         patch("hoga.api.scheduler.find_ineligible_dates", return_value=[]), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock,
               return_value=EnqueueResponse(enqueued=[], deduped=[])) as enq:
        result = await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    # reconcile: 마커가 디스크 진실(20260524)로 맞춰졌다.
    entries = watchlist.load_watchlist(tmp_path)
    assert entries[0].last_success_date == "20260524"
    # 적재는 오늘 하루 — 마커(20260524)는 floor 로 쓰이지 않는다.
    trading.assert_called_with("20260527", "20260527")
    enq.assert_awaited_once()
    call_req = enq.await_args.kwargs.get("req") or enq.await_args.args[0]
    assert call_req.dates == ["20260527"]
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
    fake_now = dt.datetime(2026, 5, 27, 10, 0, 0, tzinfo=KST)  # before 17
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
async def test_catchup_one_entry_propagates_trading_day_unavailable(tmp_path: Path):
    """TradingDayUnavailableError must PROPAGATE (no enqueue) — swallowing it
    here made the routes' error envelope unreachable dead code, so a KIS
    calendar outage reported per-entry success (enqueued=0, error=None) and
    the gap silently persisted."""
    from hoga.api import scheduler
    from hoga.api.calendar import TradingDayUnavailableError
    from hoga.api.error_codes import UpstreamCode
    from hoga.api.models import WatchlistEntry
    entry = WatchlistEntry(
        code="003490", name="대한항공",
        registered_at_kst_date="20260520",
        last_success_date=None,
    )
    fake_now = dt.datetime(2026, 5, 27, 19, 0, 0, tzinfo=KST)
    def boom(*args, **kwargs):
        raise TradingDayUnavailableError(UpstreamCode.TRADING_DAYS_UNAVAILABLE)
    with patch("hoga.api.scheduler.latest_complete_date", return_value=None), \
         patch("hoga.api.scheduler.trading_days_in_range", side_effect=boom), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq, pytest.raises(TradingDayUnavailableError):
        await scheduler.catchup_one_entry(
            entry, data_dir=tmp_path, now=fake_now,
        )
    assert enq.await_count == 0


# --- Coverage gaps from /review audit (2026-05-27) -------------------------


@pytest.mark.parametrize("inp,expected", [
    ("20260131", "20260201"),  # month rollover
    ("20261231", "20270101"),  # year rollover
    ("20280228", "20280229"),  # leap year (2028 is divisible by 4)
    ("20290228", "20290301"),  # NON-leap year (2029)
    ("20260228", "20260301"),  # standard February-end (non-leap)
])
def test_next_kst_day_rollovers(inp: str, expected: str):
    """next_kst_day boundaries: month, year, leap-day, non-leap February.
    The catch-up logic uses this to compute start = day after last_success;
    a rollover bug would produce out-of-bounds dates the trading-day
    expander would silently filter out. (Hoisted to orchestrator — the single
    Clock seam — and shared by scheduler day-stepping + screener gap logic.)"""
    from hoga.collector.orchestrator import next_kst_day
    assert next_kst_day(inp) == expected


@pytest.mark.asyncio
async def test_daily_loop_survives_daily_run_crash(tmp_path: Path):
    """The perpetual loop's 'never let one failure kill the loop' contract
    (ADR-0034). Drive one iteration with _daily_run raising, then a second
    iteration with sleep raising CancelledError to exit cleanly. The loop
    must swallow the crash and proceed to the next sleep."""
    import asyncio as _asyncio

    from hoga.api import scheduler
    iteration = {"n": 0}

    async def fake_sleep(_secs):
        iteration["n"] += 1
        if iteration["n"] >= 2:
            raise _asyncio.CancelledError

    async def boom(_data_dir):
        raise RuntimeError("simulated crash inside _daily_run")

    with patch("hoga.api.scheduler.asyncio.sleep", side_effect=fake_sleep), \
         patch("hoga.api.scheduler.now_kst", return_value=_at(17, 0)), \
         patch("hoga.api.scheduler._daily_run", side_effect=boom) as run_spy, pytest.raises(_asyncio.CancelledError):
        await scheduler._daily_loop(tmp_path)
    # First iteration ran _daily_run (which crashed); the loop did NOT
    # propagate the crash — it advanced to the second sleep.
    assert run_spy.await_count == 1
    assert iteration["n"] == 2
    # 실패도 마커를 찍는다 — 그래야 60초마다 promote/prune 전체 스윕이 재실행되지 않는다.
    assert scheduler.read_last_daily_run_date(tmp_path) == "20260526"


# ── 놓친 실행 복구 / 절전 드리프트 (17:00 단발 sleep 교체) ────────────────────

def test_daily_run_not_due_before_17():
    from hoga.api.scheduler import daily_run_due
    assert daily_run_due(_at(16, 59), last_run_date=None) is False


def test_daily_run_due_after_17_when_never_run():
    """16:00 크래시 → 17:30 재기동이 그날 런을 복구해야 한다.

    구 동작은 다음 17:00 까지 ~23시간을 단발로 잤고, 그래서 그날 런(승격·prune·
    오늘 enqueue·스크리너·depth_daily)이 영구히 건너뛰어졌다.
    """
    from hoga.api.scheduler import daily_run_due
    assert daily_run_due(_at(17, 30), last_run_date=None) is True


def test_daily_run_not_due_when_already_ran_today():
    from hoga.api.scheduler import daily_run_due
    assert daily_run_due(_at(23, 59), last_run_date="20260526") is False


def test_daily_run_due_again_the_next_day():
    from hoga.api.scheduler import daily_run_due
    assert daily_run_due(_at(17, 0, day=27), last_run_date="20260526") is True


def test_last_daily_run_date_roundtrips(tmp_path: Path):
    from hoga.api.scheduler import read_last_daily_run_date, write_last_daily_run_date
    assert read_last_daily_run_date(tmp_path) is None
    write_last_daily_run_date(tmp_path, "20260526")
    assert read_last_daily_run_date(tmp_path) == "20260526"


def test_corrupt_marker_reads_as_never_run(tmp_path: Path):
    """마커는 캐시다 — 손상 시 그날 런이 한 번 더 도는 게 최악이어야 한다."""
    from hoga.api.scheduler import _scheduler_state_path, read_last_daily_run_date
    _scheduler_state_path(tmp_path).write_text("{ not json", encoding="utf-8")
    assert read_last_daily_run_date(tmp_path) is None


@pytest.mark.asyncio
async def test_daily_loop_runs_once_per_day_across_many_ticks(tmp_path: Path):
    """폴링 루프가 60초마다 깨어도 하루 1회만 실행한다(마커가 멱등성 담당)."""
    import asyncio as _asyncio

    from hoga.api import scheduler
    iteration = {"n": 0}

    async def fake_sleep(_secs):
        iteration["n"] += 1
        if iteration["n"] >= 5:
            raise _asyncio.CancelledError

    with patch("hoga.api.scheduler.asyncio.sleep", side_effect=fake_sleep), \
         patch("hoga.api.scheduler.now_kst", return_value=_at(17, 5)), \
         patch("hoga.api.scheduler._daily_run", new=AsyncMock()) as run_spy, \
         pytest.raises(_asyncio.CancelledError):
        await scheduler._daily_loop(tmp_path)

    assert run_spy.await_count == 1, "폴링 틱마다 재실행하면 안 된다"
    assert iteration["n"] == 5


@pytest.mark.asyncio
async def test_daily_loop_skips_run_before_trigger_hour(tmp_path: Path):
    """17:00 전에는 폴링만 하고 실행하지 않는다."""
    import asyncio as _asyncio

    from hoga.api import scheduler
    iteration = {"n": 0}

    async def fake_sleep(_secs):
        iteration["n"] += 1
        if iteration["n"] >= 3:
            raise _asyncio.CancelledError

    with patch("hoga.api.scheduler.asyncio.sleep", side_effect=fake_sleep), \
         patch("hoga.api.scheduler.now_kst", return_value=_at(10, 0)), \
         patch("hoga.api.scheduler._daily_run", new=AsyncMock()) as run_spy, \
         pytest.raises(_asyncio.CancelledError):
        await scheduler._daily_loop(tmp_path)

    assert run_spy.await_count == 0
    assert scheduler.read_last_daily_run_date(tmp_path) is None


@pytest.mark.asyncio
async def test_daily_run_swallows_trading_day_lookup_failure(tmp_path: Path):
    """If trading_days_in_range raises (KRX unavailable, etc.), _daily_run
    must log + return; downstream enqueue_items_core must NOT be called.
    Pins the silent-failure branch at scheduler.py:48 in the diff."""
    from hoga.api import scheduler
    await _seed(tmp_path, code="003490", name="대한항공",
                              today_kst_date="20260520")
    fake_now = dt.datetime(2026, 5, 27, 18, 0, tzinfo=KST)
    with patch("hoga.api.scheduler.now_kst", return_value=fake_now), \
         patch("hoga.api.scheduler.trading_days_in_range",
               side_effect=RuntimeError("KRX down")), \
         patch("hoga.api.scheduler.enqueue_items_core",
               new_callable=AsyncMock) as enq:
        await scheduler._daily_run(tmp_path)
    assert enq.await_count == 0


# ── 거래일 판정 불가 = 재시도 (2026-08-03) ──────────────────────────────────
#
# 17:00 의 KIS chk-holiday 일시 장애가 휴장일과 똑같이 처리되던 시절에는, 그날
# 관심종목 enqueue 가 통째로 사라지고 마커까지 찍혀 재시도가 없었다. hogaplay
# 업스트림 보유가 ~18시간이라 다음 날 사람이 알아챌 때면 복구 불가였다.


@pytest.mark.asyncio
async def test_trading_stage_is_unsettled_when_verdict_unavailable(tmp_path: Path):
    """판정 불가면 enqueue 하지 않고 '미결(False)' 을 돌려준다."""
    from hoga.api import scheduler

    with patch("hoga.api.scheduler.daily_run_allowed_by_calendar", AsyncMock(return_value=None)), \
         patch("hoga.api.scheduler.load_watchlist") as watchlist_spy, \
         patch("hoga.api.scheduler.now_kst", return_value=_at(17, 0)):
        settled = await scheduler.run_trading_stage(tmp_path)

    assert settled is False
    # 판정을 못 받았으면 오늘 몫을 담아서는 안 된다 — 휴장일 수도 있다.
    assert watchlist_spy.call_count == 0


@pytest.mark.asyncio
async def test_trading_stage_is_settled_on_a_confirmed_holiday(tmp_path: Path):
    """휴장은 **확정** 판정이다 — 재시도 대상이 아니다(매일 재시도하면 안 된다)."""
    from hoga.api import scheduler

    with patch("hoga.api.scheduler.daily_run_allowed_by_calendar", AsyncMock(return_value=False)), \
         patch("hoga.api.scheduler.load_watchlist") as watchlist_spy, \
         patch("hoga.api.scheduler.now_kst", return_value=_at(17, 0)):
        settled = await scheduler.run_trading_stage(tmp_path)

    assert settled is True
    assert watchlist_spy.call_count == 0


@pytest.mark.asyncio
async def test_daily_loop_retries_only_the_trading_stage_until_it_settles(tmp_path: Path):
    """미결이면 다음 틱이 **뒷단만** 다시 시도하고, 확정되면 마커를 찍고 멈춘다.

    앞단(promote·prune, 전체 트리 스윕)은 재시도 대상이 아니다 — 그걸 60초마다
    되돌리면 자정까지 수백 번 재실행된다. 두 마커가 그 경계를 만든다.
    """
    import asyncio as _asyncio

    from hoga.api import scheduler
    ticks = {"n": 0}

    async def fake_sleep(_secs):
        ticks["n"] += 1
        if ticks["n"] >= 3:
            raise _asyncio.CancelledError

    # 1틱: 전체 런은 돌았지만 달력 판정이 안 나 미결(False).
    # 2틱: 재시도에서 KIS 가 회복돼 확정(True). 3틱: 더 이상 시도하지 않는다.
    retry_results = [True]

    async def fake_trading_stage(_data_dir):
        return retry_results.pop(0)

    with patch("hoga.api.scheduler.asyncio.sleep", side_effect=fake_sleep), \
         patch("hoga.api.scheduler.now_kst", return_value=_at(17, 0)), \
         patch("hoga.api.scheduler._daily_run", AsyncMock(return_value=False)) as full_run, \
         patch("hoga.api.scheduler.run_trading_stage", side_effect=fake_trading_stage) as retry, \
         pytest.raises(_asyncio.CancelledError):
        await scheduler._daily_loop(tmp_path)

    # 비싼 앞단은 딱 한 번. 미결이어도 되돌리지 않는다.
    assert full_run.await_count == 1
    # 값싼 뒷단만 재시도됐고, 확정된 뒤로는 3틱째에 다시 시도하지 않았다.
    assert retry.call_count == 1
    assert scheduler.read_last_daily_run_date(tmp_path) == "20260526"
    assert scheduler.read_last_trading_stage_date(tmp_path) == "20260526"


def test_markers_do_not_overwrite_each_other(tmp_path: Path):
    """한 마커 갱신이 다른 마커를 지우면 재시도 게이트가 조용히 무력화된다."""
    from hoga.api import scheduler

    scheduler.write_last_daily_run_date(tmp_path, "20260526")
    scheduler.write_last_trading_stage_date(tmp_path, "20260526")
    assert scheduler.read_last_daily_run_date(tmp_path) == "20260526"

    scheduler.write_last_daily_run_date(tmp_path, "20260527")
    assert scheduler.read_last_trading_stage_date(tmp_path) == "20260526"


# --- daily enqueue set = watchlist ∪ heatmap (ADR-0142) ----------------------

def _write_heatmap(tmp_path: Path, codes: list[str]) -> None:
    import json
    (tmp_path / "heatmap.json").write_text(json.dumps({
        "schema_version": 4,
        "folders": [{"id": "f_0000000a", "name": "반도체", "order": 0}],
        "entries": [{"code": c, "name": c, "folder_id": "f_0000000a", "order": i}
                    for i, c in enumerate(codes)],
        "capture_markers": {},
    }, ensure_ascii=False), encoding="utf-8")


@pytest.mark.asyncio
async def test_daily_enqueue_codes_is_watchlist_first_then_heatmap(tmp_path: Path):
    """관심종목 먼저, 히트맵 뒤, 중복은 1회.

    순서가 계약인 이유: 큐는 FIFO 이고 hogaplay 보유가 ~18시간이라 뒤로 밀린 종목일수록
    유실 위험이 크다. 사용자가 실제로 매매를 보는 관심종목이 앞에 서야 한다.
    """
    from hoga.api import scheduler
    await _seed(tmp_path, code="005930", name="삼성전자", today_kst_date="20260526")
    _write_heatmap(tmp_path, ["000660", "005930"])   # 005930 은 양쪽에 있다
    assert scheduler.daily_enqueue_codes(tmp_path) == ["005930", "000660"]


def test_daily_enqueue_codes_dedupes_a_code_registered_in_two_groups(tmp_path: Path):
    """히트맵 entry 는 (folder_id, code) 라 한 종목이 여러 그룹에 있다 — 코드로 접는다.

    큐도 같은 (code,date) 를 deduped 로 되돌리지만 그건 큐의 방어이지 계획의 정확성이
    아니다: dedup 없이는 "N종목 적재" 로그가 실제 종목 수와 어긋난다.
    """
    import json

    from hoga.api import scheduler
    (tmp_path / "heatmap.json").write_text(json.dumps({
        "schema_version": 4,
        "folders": [{"id": "f_0000000a", "name": "반도체", "order": 0},
                    {"id": "f_0000000b", "name": "AI", "order": 1}],
        "entries": [
            {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000a", "order": 0},
            {"code": "005930", "name": "삼성전자", "folder_id": "f_0000000b", "order": 0},
        ],
        "capture_markers": {},
    }, ensure_ascii=False), encoding="utf-8")
    assert scheduler.daily_enqueue_codes(tmp_path) == ["005930"]


def test_daily_enqueue_codes_survives_a_missing_heatmap(tmp_path: Path):
    """heatmap.json 이 없어도 관심종목 적재는 돈다(신규 머신)."""
    from hoga.api import scheduler
    assert scheduler.daily_enqueue_codes(tmp_path) == []
