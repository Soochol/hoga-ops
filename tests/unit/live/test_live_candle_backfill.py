from __future__ import annotations

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
