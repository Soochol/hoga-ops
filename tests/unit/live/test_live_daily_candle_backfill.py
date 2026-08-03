from __future__ import annotations

import asyncio
import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_daily_candles, kiwoom_rest_runtime
from hoga.live.api import batched_daily_walkback
from hoga.live.candle_fetch_result import DailyCandleFetchResult
from hoga.live.candle_models import LiveCandle
from hoga.live.live_daily_candle_backfill import LiveDailyCandleBackfill
from hoga.live.past_daily_candles_cache import PastDailyCandlesCache


def _daily_candles(from_yyyymmdd: str, to_yyyymmdd: str, *, close: int = 105) -> list[LiveCandle]:
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
    out: list[LiveCandle] = []
    cur = start
    while cur <= end:
        out.append(
            LiveCandle(
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
        self.calls: list[tuple[str, str, str, str | None, bool]] = []

    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool = True,
    ) -> DailyCandleFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd, venue, adjust))
        return DailyCandleFetchResult(
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd),
            violations=[],
        )


class _FallbackKis(_FakeKis):
    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool = True,
    ) -> DailyCandleFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd, venue, adjust))
        if venue == "UN":
            return DailyCandleFetchResult(candles=[], violations=[])
        return DailyCandleFetchResult(
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd, close=205),
            violations=[],
        )


class _RecordingScheduler:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[], Awaitable],
    ):
        # 계정 차원(endpoint·cooldown_scope)은 PR-F(#1042)에서 사라졌다 —
        # 키움 유량은 TR별이라 고를 계정이 없다(#1015). api_id 가 버킷 키다.
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call()


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 2점(클라이언트 조달·어댑터 함수)을 갈아끼운다.

    PR-F 이후 소비자는 클라이언트 객체를 들고 다니지 않는다: 런타임에서 받아
    **모듈 레벨 어댑터 함수**를 부른다. 그래서 페이크도 그 함수 자리에 꽂는다.
    """
    def _install(fake: _FakeKis) -> _FakeKis:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
        )
        monkeypatch.setattr(
            kiwoom_daily_candles, "fetch_daily_candles", fake.fetch_daily_candles
        )
        return fake

    return _install


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_schedules_past_daily_fetches(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeKis())
    scheduler = _RecordingScheduler()
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
            "api_id": "ka10081",
            "priority": "user_visible",
        }
    ]


class _GatedKis(_FakeKis):
    """Blocks inside the first fetch so a second concurrent request races into
    (or is coalesced out of) the walk-back."""

    def __init__(self) -> None:
        super().__init__()
        self.gate = asyncio.Event()

    async def fetch_daily_candles(
        self,
        _client,
        code: str,
        from_yyyymmdd: str,
        to_yyyymmdd: str,
        *,
        venue: str | None = None,
        adjust: bool = True,
    ) -> DailyCandleFetchResult:
        self.calls.append((code, from_yyyymmdd, to_yyyymmdd, venue, adjust))
        await self.gate.wait()
        return DailyCandleFetchResult(
            candles=_daily_candles(from_yyyymmdd, to_yyyymmdd),
            violations=[],
        )


@pytest.mark.asyncio
async def test_collect_daily_coalesces_concurrent_same_venue_code_requests(tmp_path, kiwoom) -> None:
    # Overlapping [from, today] requests for the same (venue, code) on a cold
    # cache must share one KIS walk-back — the second reads the warm cache.
    kis = kiwoom(_GatedKis())
    scheduler = _RecordingScheduler()
    backfill = LiveDailyCandleBackfill(
        data_dir=tmp_path,
        cache=PastDailyCandlesCache(),
        scheduler=scheduler,  # type: ignore[arg-type]
        walkback=batched_daily_walkback,
    )

    async def one(frm: dt.date, from_label: str):
        return await backfill.collect_daily(
            code="005930",
            frm=frm,
            too=dt.date(2024, 1, 10),
            today_d=dt.date(2024, 2, 1),
            policy="KRX",
            from_label=from_label,
            to_label="20240110",
        )

    t1 = asyncio.create_task(one(dt.date(2024, 1, 1), "20240101"))
    t2 = asyncio.create_task(one(dt.date(2024, 1, 5), "20240105"))

    for _ in range(100):
        await asyncio.sleep(0)
        if kis.calls:
            break
    assert len(kis.calls) == 1

    kis.gate.set()
    r1, r2 = await asyncio.gather(t1, t2)

    assert len(kis.calls) == 1
    assert len(r1["candles"]) == 10
    assert len(r2["candles"]) == 6
    assert r2["fresh_batches"] == []
    assert r2["cached_batches"] == ["20240101__20240110"]


@pytest.mark.asyncio
async def test_live_daily_candle_backfill_falls_back_to_krx_for_empty_integrated(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FallbackKis())
    scheduler = _RecordingScheduler()
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
    # venue 는 `cooldown_scope`(계정 축) 가 아니라 **중복제거 key** 로만 구분된다 —
    # PR-F(#1042)에서 계정 차원이 사라졌기 때문이다(#1015). key 쪽이 더 강한 신호다:
    # primary/fallback 을 함께 못 박는다.
    assert [call["key"][2] for call in scheduler.calls] == ["UN", "KRX"]
    assert scheduler.calls[1]["key"][-1] == "fallback"
    assert [c[3] for c in kis.calls] == ["UN", "KRX"], "어댑터에도 venue 가 흘러야 한다"
    assert any(
        warning["reason"] == "daily_fallback_to_krx"
        and warning["batch"] == "20240101__20240105"
        for warning in result["data_warnings"]
    )
