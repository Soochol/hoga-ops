from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live.kis_capacity_scheduler import KisCapacityOverloaded
from hoga.live.kis_client import KisClient
from hoga.live.kis_models import KisCandle
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str, hour: int = 9, minute: int = 0) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    y = int(date_yyyymmdd[:4])
    m = int(date_yyyymmdd[4:6])
    d = int(date_yyyymmdd[6:8])
    return int(dt.datetime(y, m, d, hour, minute, tzinfo=kst).timestamp() * 1000)


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None, bool | None]] = []

    async def fetch_past_minute_candles(
        self,
        code: str,
        date_yyyymmdd: str,
        *,
        venue: str | None = None,
        foreground: bool | None = None,
    ) -> list[KisCandle]:
        self.calls.append((code, date_yyyymmdd, venue, foreground))
        return [
            KisCandle(
                t_ms=_kst_ms(date_yyyymmdd),
                open=100,
                high=110,
                low=95,
                close=105,
                volume=10,
            )
        ]


class _RecordingScheduler:
    def __init__(self, kis: _FakeKis) -> None:
        self.kis = kis
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        endpoint: str,
        priority: str,
        call: Callable[[KisClient], Awaitable],
        cooldown_scope: Hashable | None = None,
    ):
        self.calls.append(
            {
                "key": key,
                "endpoint": endpoint,
                "priority": priority,
                "cooldown_scope": cooldown_scope,
            }
        )
        return await call(self.kis)  # type: ignore[arg-type]


class _OverloadedScheduler:
    async def submit(self, **_kwargs):
        raise KisCapacityOverloaded("KIS capacity scheduler pending request limit reached")


@pytest.mark.asyncio
async def test_live_minute_candle_backfill_schedules_past_minute_fetches(tmp_path) -> None:
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )

    assert result.fresh_dates == ["20260518"]
    assert result.cached_dates == []
    assert result.data_warnings == []
    assert len(result.candles) == 1
    assert kis.calls == [("005930", "20260518", "NXT", True)]
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute", "NXT", "005930", "20260518"),
            "endpoint": "past-minute",
            "priority": "user_visible",
            "cooldown_scope": "NXT",
        }
    ]


@pytest.mark.asyncio
async def test_collect_minute_skips_known_non_trading_past_dates(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(
        cal,
        "is_trading_day",
        lambda d: False if d == "20260517" else True,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert kis.calls == [("005930", "20260518", "KRX", True)]
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute", "KRX", "005930", "20260518"),
            "endpoint": "past-minute",
            "priority": "user_visible",
            "cooldown_scope": "KRX",
        }
    ]
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == ["20260518"]
    assert len(result.candles) == 1
    assert result.data_warnings == []


@pytest.mark.asyncio
async def test_collect_minute_treats_non_trading_empty_as_covered_for_fallback(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(cal, "is_trading_day", lambda d: False)

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 17),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )

    assert kis.calls == []
    assert scheduler.calls == []
    assert result.candles == []
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == []
    assert result.data_warnings == []


@pytest.mark.asyncio
async def test_live_minute_candle_backfill_reports_capacity_overload(tmp_path) -> None:
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_OverloadedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.candles == []
    assert result.fresh_dates == []
    assert result.cached_dates == []
    assert result.data_warnings == [
        {
            "date": "20260518",
            "reason": "capacity_overloaded",
            "msg": "KIS capacity scheduler pending request limit reached",
        }
    ]


@pytest.mark.asyncio
async def test_warm_minute_fetches_uncached_dates_at_background_priority(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    status = await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 19),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )
    task = backfill._warm_tasks[("KRX", "005930")]
    await task

    assert status == "started"
    assert [c["priority"] for c in scheduler.calls] == ["background", "background"]
    # 토큰버킷 레이어(ADR-0087 2층)에서도 background여야 한다: foreground=True로
    # 참칭하면 warm이 사용자 호출에 토큰을 양보하지 않아 EGW00201 폭풍의 원인이 된다.
    assert [c[3] for c in kis.calls] == [False, False]
    assert cache.get_past("KRX", "005930", "20260518") is not None
    assert cache.get_past("KRX", "005930", "20260519") is not None


@pytest.mark.asyncio
async def test_warm_minute_new_code_cancels_other_codes_warm(
    tmp_path, monkeypatch,
) -> None:
    """활성화 warm은 latest-wins: 새 종목의 warm이 시작되면 다른 종목의 진행 중
    warm은 취소된다. 종목 전환마다 warm 스트림이 누적돼(종목당 ~240 KIS 콜)
    지속 포화 → EGW00201 폭풍을 만들던 회귀의 재발 방지."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    release = asyncio.Event()

    class _BlockedScheduler:
        async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
            await release.wait()
            return await call(_FakeKis())  # type: ignore[arg-type]

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_BlockedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    common = dict(
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    await backfill.warm_minute(code="005930", **common)
    task_a = backfill._warm_tasks[("KRX", "005930")]
    await asyncio.sleep(0)  # task_a가 blocked submit까지 진입

    await backfill.warm_minute(code="000660", **common)
    task_b = backfill._warm_tasks[("KRX", "000660")]
    await asyncio.sleep(0)  # 취소 전파

    assert task_a.cancelled() or task_a.cancelling()
    release.set()
    await task_b
    with pytest.raises(asyncio.CancelledError):
        await task_a
    # 같은 code 재호출은 여전히 단일 비행(취소 아님).
    still = await backfill.warm_minute(code="000660", **common)
    assert still in {"started", "already_running"}


@pytest.mark.asyncio
async def test_fetch_past_shared_corider_survives_waiter_cancellation(tmp_path) -> None:
    """한 대기자의 취소가 공유 single-flight 태스크에 올라탄 다른 대기자를 죽이는
    회귀 가드(/investigate 2026-07-10). bare `await task`는 대기자 취소를
    _fut_waiter.cancel()로 공유 태스크까지 전파한다 — warm latest-wins 취소
    (warm_minute)가 이 경로로 같은 날짜에 올라탄 사용자 /past-candles 요청을
    CancelledError로 죽였다. 조인 지점은 shield여야 한다."""
    kis = _FakeKis()
    gate = asyncio.Event()

    class _GatedScheduler:
        async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
            await gate.wait()
            return await call(kis)  # type: ignore[arg-type]

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_GatedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    warm_rider = asyncio.create_task(
        backfill._fetch_past_shared("KRX", "005930", "20260518")
    )
    user_rider = asyncio.create_task(
        backfill._fetch_past_shared("KRX", "005930", "20260518")
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)  # 두 rider 모두 공유 태스크에 매달린 상태

    warm_rider.cancel()  # warm_minute latest-wins의 other_task.cancel() 모사
    await asyncio.sleep(0)
    gate.set()

    bars = await user_rider  # shield 없으면 여기서 CancelledError
    assert len(bars) == 1
    assert kis.calls == [("005930", "20260518", "KRX", True)]
    with pytest.raises(asyncio.CancelledError):
        await warm_rider


@pytest.mark.asyncio
async def test_warm_minute_single_flight_per_venue_code(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    release = asyncio.Event()

    class _BlockedScheduler:
        async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
            await release.wait()
            return await call(_FakeKis())  # type: ignore[arg-type]

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_BlockedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    common = dict(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    first = await backfill.warm_minute(**common)
    second = await backfill.warm_minute(**common)
    task = backfill._warm_tasks[("KRX", "005930")]
    release.set()
    await task

    assert (first, second) == ("started", "already_running")


@pytest.mark.asyncio
async def test_warm_minute_skips_cached_and_today(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    cache.store_past("KRX", "005930", "20260518", [])
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 20),  # 5/20 == today → 제외
        today_d=dt.date(2026, 5, 20),
        policy="KRX",
    )
    await backfill._warm_tasks[("KRX", "005930")]

    # 캐시된 5/18과 today 5/20은 건너뛰고 5/19만 fetch
    assert [c["key"] for c in scheduler.calls] == [
        ("live-candle-backfill", "minute", "KRX", "005930", "20260519"),
    ]


@pytest.mark.asyncio
async def test_warm_minute_stops_on_rate_limit(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal
    from hoga.live.kis_client import KisRateLimitError

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)

    class _RateLimitedScheduler:
        def __init__(self) -> None:
            self.count = 0

        async def submit(self, **_kwargs):
            self.count += 1
            raise KisRateLimitError("rate limit")

    scheduler = _RateLimitedScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 22),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )
    await backfill._warm_tasks[("KRX", "005930")]

    assert scheduler.count == 1  # 첫 레이트리밋에서 즉시 중단, 나머지 날짜 시도 금지
    assert backfill._rate_limited_now() is True


@pytest.mark.asyncio
async def test_warm_minute_identity_guard_survives_stale_done_callback(
    tmp_path, monkeypatch,
) -> None:
    """Pins the race the plain single-flight test misses: task1 fully COMPLETES,
    its ``_done`` callback is still pending (call_soon), a second warm starts
    task2 and stores it, THEN task1's stale callback fires. Without the identity
    guard, task1's ``_done`` unconditionally pops the registry key and evicts
    task2 — defeating single-flight. The guard (``get(k) is t``) must keep task2's
    entry intact.

    We drive the ordering deterministically by making the scheduler block on an
    Event, so we control exactly when each task's coroutine finishes and when its
    callback is allowed to run.
    """
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    gate1 = asyncio.Event()
    gate2 = asyncio.Event()
    events = [gate1, gate2]

    class _GatedScheduler:
        def __init__(self) -> None:
            self._idx = 0

        async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
            gate = events[self._idx]
            self._idx += 1
            await gate.wait()
            return await call(_FakeKis())  # type: ignore[arg-type]

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_GatedScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    common = dict(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    # Start task1 and let its coroutine run to COMPLETION, but suppress its
    # done-callback so the registry still holds task1's entry.
    await backfill.warm_minute(**common)
    task1 = backfill._warm_tasks[("KRX", "005930")]
    suppressed = []
    for cb in list(task1._callbacks):  # type: ignore[attr-defined]
        fn = cb[0] if isinstance(cb, tuple) else cb
        if getattr(fn, "__name__", "") == "_done":
            task1.remove_done_callback(fn)
            suppressed.append(fn)
    gate1.set()
    await task1  # task1.done() is now True; its _done did NOT run (we suppressed it)
    assert task1.done()

    # Second warm sees task1.done() → falls through, creates+stores task2.
    status2 = await backfill.warm_minute(**common)
    task2 = backfill._warm_tasks[("KRX", "005930")]
    assert status2 == "started"
    assert task2 is not task1

    # Now fire task1's STALE callback (as call_soon would). With the identity
    # guard it is a no-op for the registry; without it, this evicts task2.
    for fn in suppressed:
        fn(task1)
    assert backfill._warm_tasks.get(("KRX", "005930")) is task2

    # Drain task2 cleanly.
    gate2.set()
    await task2
    await asyncio.sleep(0)
    assert ("KRX", "005930") not in backfill._warm_tasks


@pytest.mark.asyncio
async def test_warm_minute_logs_unexpected_exception(
    tmp_path, monkeypatch, caplog,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)

    class _BoomScheduler:
        async def submit(self, **_kwargs):
            raise ValueError("boom")

    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_BoomScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )
    import logging
    with caplog.at_level(logging.WARNING):
        await backfill.warm_minute(
            code="005930",
            frm=dt.date(2026, 5, 18),
            too=dt.date(2026, 5, 18),
            today_d=dt.date(2026, 6, 1),
            policy="KRX",
        )
        task = backfill._warm_tasks.get(("KRX", "005930"))
        if task is not None:
            with pytest.raises(ValueError):
                await task
        await asyncio.sleep(0)
        await asyncio.sleep(0)

    assert any("live candle warm failed" in r.message for r in caplog.records)
    assert ("KRX", "005930") not in backfill._warm_tasks


@pytest.mark.asyncio
async def test_collect_minute_read_ahead_warms_preceding_window(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
    )
    task = backfill._warm_tasks.get(("KRX", "005930"))
    assert task is not None
    await task

    # 요청창 5/20-21은 user_visible, 선행창 5/18-19는 background
    priorities = [c["priority"] for c in scheduler.calls]
    assert priorities.count("user_visible") == 2
    assert priorities.count("background") == 2
    assert cache.get_past("KRX", "005930", "20260518") is not None
    assert cache.get_past("KRX", "005930", "20260519") is not None


@pytest.mark.asyncio
async def test_collect_minute_read_ahead_respects_earliest_allowed(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,
        concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
        earliest_allowed=dt.date(2026, 5, 20),  # 선행창 전체가 하한 밖 → 워밍 없음
    )

    assert ("KRX", "005930") not in backfill._warm_tasks
    assert all(c["priority"] == "user_visible" for c in scheduler.calls)


@pytest.mark.asyncio
async def test_collect_minute_default_no_read_ahead(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,
        concurrency=1,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 5, 21),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert ("KRX", "005930") not in backfill._warm_tasks


@pytest.mark.asyncio
async def test_warm_minute_fetches_newest_date_first(tmp_path, monkeypatch) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,
        concurrency=1,
    )

    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 20),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )
    await backfill._warm_tasks[("KRX", "005930")]

    # _warm_run은 다음 청크가 가장 먼저 필요로 하는 최신 날짜를 먼저 fetch한다.
    fetched_dates = [c["key"][-1] for c in scheduler.calls]
    assert fetched_dates == ["20260520", "20260519", "20260518"]


class _VenueAwareFakeKis:
    """KRX엔 캔들, NXT/UN엔 빈 결과 — NXT→KRX 폴백 시나리오 재현."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str | None, bool | None]] = []

    async def fetch_past_minute_candles(
        self,
        code: str,
        date_yyyymmdd: str,
        *,
        venue: str | None = None,
        foreground: bool | None = None,
    ) -> list[KisCandle]:
        self.calls.append((code, date_yyyymmdd, venue, foreground))
        if venue == "KRX":
            return [
                KisCandle(
                    t_ms=_kst_ms(date_yyyymmdd),
                    open=100, high=110, low=95, close=105, volume=10,
                )
            ]
        return []  # NXT/UN: empty


@pytest.mark.asyncio
async def test_warm_then_read_non_krx_empty_does_not_suppress_krx_fallback(
    tmp_path, monkeypatch,
) -> None:
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _VenueAwareFakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler, concurrency=1,
    )

    # 1) NXT를 워밍한다. NXT는 빈 결과 → 워밍이 NXT [] 를 캐시에 남기면 안 된다.
    await backfill.warm_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )
    await backfill._warm_tasks[("NXT", "005930")]
    # 워밍이 NXT 빈 항목을 캐시에 남기지 않았어야 한다.
    assert cache.get_past("NXT", "005930", "20260518") is None

    # 2) 같은 날짜를 NXT로 읽으면 KRX 폴백이 살아나 KRX 캔들이 나와야 한다.
    out = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="NXT",
    )
    assert len(out.candles) == 1  # KRX 폴백 캔들
    assert any(w.get("reason") == "minute_fallback_to_krx" for w in out.data_warnings)


@pytest.mark.asyncio
async def test_collect_minute_caps_uncached_fetches_per_request(tmp_path, monkeypatch) -> None:
    """예산(3)보다 큰 미캐시 창(10일) → 최신 3일만 fetch, 나머지는 budget 경고로 유예."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    assert sorted(d for _, d, _, _ in kis.calls) == ["20260508", "20260509", "20260510"]
    warned = [w for w in result.data_warnings if w["reason"] == "fetch_budget_exhausted"]
    assert [w["date"] for w in warned] == [f"2026050{d}" for d in range(1, 8)]


@pytest.mark.asyncio
async def test_budget_counts_only_uncached_dates(tmp_path, monkeypatch) -> None:
    """캐시된 날짜는 예산을 소모하지 않는다."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    cache = PastCandlesCache(data_dir=tmp_path)
    for day in range(1, 8):  # 5/1-5/7 캐시 채움 → 미캐시는 5/8-5/10 셋뿐
        date_s = f"2026050{day}"
        cache.store_past("KRX", "005930", date_s, [
            {"t_ms": _kst_ms(date_s), "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1},
        ])
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path, cache=cache, scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1, max_fresh_dates_per_collect=3,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert result.fresh_dates == ["20260508", "20260509", "20260510"]
    assert result.data_warnings == []  # 예산 내 완결 → 경고 없음


@pytest.mark.asyncio
async def test_budget_exhausted_suppresses_read_ahead(tmp_path, monkeypatch) -> None:
    """예산 초과 경고가 있으면 read_ahead 워밍을 건너뛴다(증폭 차단)."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=3,
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 1),
        too=dt.date(2026, 5, 10),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
        read_ahead=True,
    )

    assert ("KRX", "005930") not in backfill._warm_tasks


@pytest.mark.asyncio
async def test_read_ahead_span_capped(tmp_path, monkeypatch) -> None:
    """40일 요청창이라도 선행 워밍은 직전 15일만(자기증폭 차단)."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
        max_fresh_dates_per_collect=100,  # 예산 경고로 워밍이 스킵되지 않게 격리
    )

    await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 20),
        too=dt.date(2026, 6, 28),  # 40일 창
        today_d=dt.date(2026, 7, 1),
        policy="KRX",
        read_ahead=True,
    )
    task = backfill._warm_tasks.get(("KRX", "005930"))
    assert task is not None
    await task

    # 선행창 = [frm-15, frm-1] = 2026-05-05 .. 2026-05-19 (전부 거래일 mock)
    bg_dates = sorted(
        c["key"][4] for c in scheduler.calls if c["priority"] == "background"
    )
    assert bg_dates[0] == "20260505"
    assert bg_dates[-1] == "20260519"
    assert len(bg_dates) == 15
