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
    assert cache.get_past("KRX", "005930", "20260518") is not None
    assert cache.get_past("KRX", "005930", "20260519") is not None


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
