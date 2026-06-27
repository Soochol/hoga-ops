from __future__ import annotations

import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live.api import batched_daily_walkback
from hoga.live.kis_client import DailyCandleFetchResult, KisClient
from hoga.live.kis_models import KisCandle
from hoga.live.live_daily_candle_backfill import LiveDailyCandleBackfill
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _daily_candles(from_yyyymmdd: str, to_yyyymmdd: str, *, close: int = 105) -> list[KisCandle]:
    kst = dt.timezone(dt.timedelta(hours=9))
    start = dt.date(
        int(from_yyyymmdd[:4]),
        int(from_yyyymmdd[4:6]),
        int(from_yyyymmdd[6:8]),
    )
    end = dt.date(
        int(to_yyyymmdd[:4]),
        int(to_yyyymmdd[4:6]),
        int(to_yyyymmdd[6:8]),
    )
    out: list[KisCandle] = []
    cur = start
    while cur <= end:
        out.append(
            KisCandle(
                t_ms=int(dt.datetime(cur.year, cur.month, cur.day, 9, 0, tzinfo=kst).timestamp() * 1000),
                open=100,
                high=110,
                low=95,
                close=close,
                volume=10,
            )
        )
        cur = cur + dt.timedelta(days=1)
    return out


class _FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str, str, str | None, bool | None]] = []

    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        foreground: bool | None = None,
    ) -> DailyCandleFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd, venue, foreground))
        return DailyCandleFetchResult(
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd),
            violations=[],
        )


class _FallbackKis(_FakeKis):
    async def fetch_past_daily_candles(
        self,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        foreground: bool | None = None,
    ) -> DailyCandleFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd, venue, foreground))
        if venue == "UN":
            return DailyCandleFetchResult(candles=[], violations=[])
        return DailyCandleFetchResult(
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd, close=205),
            violations=[],
        )


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


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_schedules_past_daily_fetches(tmp_path) -> None:
    kis = _FakeKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="UN",
        from_label="20240101",
        to_label="20240105",
    )

    assert result["venue"] == "UN"
    assert result["fresh_batches"] == ["20240101__20240105"]
    assert len(result["candles"]) == 5
    assert kis.calls == [("005930", "20240101", "20240105", "UN", True)]
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "daily", "UN", "005930", "20240101", "20240105"),
            "endpoint": "past-daily",
            "priority": "user_visible",
            "cooldown_scope": "UN",
        }
    ]


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_falls_back_to_krx_for_empty_integrated(tmp_path) -> None:
    kis = _FallbackKis()
    scheduler = _RecordingScheduler(kis)
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    result = await backfill.collect_daily(
        code="005930",
        frm=dt.date(2024, 1, 1),
        too=dt.date(2024, 1, 5),
        today_d=dt.date(2024, 2, 1),
        policy="UN",
        from_label="20240101",
        to_label="20240105",
    )

    assert len(result["candles"]) == 5
    assert result["candles"][0]["close"] == 205
    assert [call["cooldown_scope"] for call in scheduler.calls] == ["UN", "KRX"]
    assert any(
        warning["reason"] == "daily_fallback_to_krx"
        and warning["batch"] == "20240101__20240105"
        for warning in result["data_warnings"]
    )
