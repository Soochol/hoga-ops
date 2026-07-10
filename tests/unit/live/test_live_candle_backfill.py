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
async def test_fetch_past_shared_corider_survives_waiter_cancellation(tmp_path) -> None:
    """한 대기자의 취소가 공유 single-flight 태스크에 올라탄 다른 대기자를 죽이는
    회귀 가드(/investigate 2026-07-10). bare `await task`는 대기자 취소를
    _fut_waiter.cancel()로 공유 태스크까지 전파한다 — 같은 (venue, code, date)를
    inflight dedup으로 공유하는 두 요청 중 하나가 취소되면(예: 타임프레임 전환
    abort) 공유 태스크가 죽어 다른 사용자 /past-candles 요청까지 CancelledError로
    죽는다. 조인 지점은 shield여야 한다."""
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

    cancelled_rider = asyncio.create_task(
        backfill._fetch_past_shared("KRX", "005930", "20260518")
    )
    user_rider = asyncio.create_task(
        backfill._fetch_past_shared("KRX", "005930", "20260518")
    )
    await asyncio.sleep(0)
    await asyncio.sleep(0)  # 두 rider 모두 공유 태스크에 매달린 상태

    cancelled_rider.cancel()  # 한 대기자의 취소(예: 타임프레임 전환 abort)
    await asyncio.sleep(0)
    gate.set()

    bars = await user_rider  # shield 없으면 여기서 CancelledError
    assert len(bars) == 1
    assert kis.calls == [("005930", "20260518", "KRX", True)]
    with pytest.raises(asyncio.CancelledError):
        await cancelled_rider


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
