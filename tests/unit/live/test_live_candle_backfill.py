from __future__ import annotations

import datetime as dt
from collections.abc import Awaitable, Callable, Hashable

import pytest

from hoga.live import kiwoom_minute_candles, kiwoom_rest_runtime
from hoga.live.candle_models import LiveCandle
from hoga.live.kiwoom_capacity import KiwoomCapacityOverloaded
from hoga.live.kiwoom_errors import KiwoomRestError
from hoga.live.kiwoom_minute_candles import MinuteWalkResult
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str, hour: int = 9, minute: int = 0) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    y = int(date_yyyymmdd[:4])
    m = int(date_yyyymmdd[4:6])
    d = int(date_yyyymmdd[6:8])
    return int(dt.datetime(y, m, d, hour, minute, tzinfo=kst).timestamp() * 1000)


def _bar(date_yyyymmdd: str) -> LiveCandle:
    return LiveCandle(
        t_ms=_kst_ms(date_yyyymmdd), open=100, high=110, low=95, close=105, volume=10,
    )


class _FakeWalk:
    """어댑터 자리에 꽂히는 페이크.

    PR-G(#1043) 이후 소비자는 **날짜별 1콜 팬**이 아니라 **구간 1회 walk-back** 을
    부른다(ADR-0136 §3). 그래서 페이크가 받는 것도 날짜가 아니라 `[oldest, newest]`
    구간이고, 그 안의 거래일을 한꺼번에 돌려준다.
    """

    def __init__(self, *, wedged: bool = False, exhausted: bool = False,
                 only: set[str] | None = None) -> None:
        self.calls: list[tuple[str, str, str, str | None]] = []
        self.day_calls: list[tuple[str, str, str | None]] = []
        self._wedged = wedged
        self._exhausted = exhausted
        self._only = only

    async def walk(self, _client, code, *, newest_yyyymmdd, oldest_yyyymmdd,
                   venue=None, **_kw) -> MinuteWalkResult:
        self.calls.append((code, oldest_yyyymmdd, newest_yyyymmdd, venue))
        bars: dict[str, list[LiveCandle]] = {}
        cur = dt.datetime.strptime(oldest_yyyymmdd, "%Y%m%d").date()
        end = dt.datetime.strptime(newest_yyyymmdd, "%Y%m%d").date()
        while cur <= end:
            date_s = cur.strftime("%Y%m%d")
            if self._only is None or date_s in self._only:
                bars[date_s] = [_bar(date_s)]
            cur += dt.timedelta(days=1)
        return MinuteWalkResult(
            bars_by_date=bars, pages=1,
            exhausted=self._exhausted, wedged=self._wedged,
        )

    async def day(self, _client, code, date_yyyymmdd, *, venue=None, **_kw):
        self.day_calls.append((code, date_yyyymmdd, venue))
        return [_bar(date_yyyymmdd)]


@pytest.fixture
def kiwoom(monkeypatch):
    """키움 이음매 3점(클라이언트 조달·walk·하루치)을 갈아끼운다."""
    def _install(fake: _FakeWalk) -> _FakeWalk:
        monkeypatch.setattr(
            kiwoom_rest_runtime, "ensure_rest_client", lambda *_a, **_k: object()
        )
        monkeypatch.setattr(kiwoom_minute_candles, "walk_minute_days", fake.walk)
        monkeypatch.setattr(kiwoom_minute_candles, "fetch_day", fake.day)
        return fake

    return _install


class _RecordingScheduler:
    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def submit(
        self,
        *,
        key: Hashable,
        api_id: str,
        priority: str,
        call: Callable[[object | None], Awaitable],
    ):
        # 계정 차원(endpoint·cooldown_scope)은 PR-G(#1043)에서 사라졌다(#1015).
        self.calls.append({"key": key, "api_id": api_id, "priority": priority})
        return await call(None)


class _OverloadedScheduler:
    async def submit(self, **_kwargs):
        raise KiwoomCapacityOverloaded("KIS capacity scheduler pending request limit reached")


@pytest.mark.asyncio
async def test_live_minute_candle_backfill_schedules_past_minute_fetches(tmp_path, kiwoom) -> None:
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
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
    assert kis.calls == [("005930", "20260518", "20260518", "NXT")]
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute", "NXT", "005930",
                    "20260518", "20260518"),
            "api_id": "ka10080",
            "priority": "user_visible",
        }
    ]


@pytest.mark.asyncio
async def test_collect_minute_skips_known_non_trading_past_dates(tmp_path, monkeypatch, kiwoom) -> None:
    from hoga.api import calendar as cal

    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=scheduler,  # type: ignore[arg-type]
        concurrency=1,
    )

    monkeypatch.setattr(
        cal,
        "is_trading_day",
        lambda d: False if d == "20260517" else True,  # noqa: SIM211 — 명시적 분기가 의도를 드러냄
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 17),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert kis.calls == [("005930", "20260518", "20260518", "KRX")], (
        "비거래일은 walk 구간에서 아예 빠진다"
    )
    assert scheduler.calls == [
        {
            "key": ("live-candle-backfill", "minute", "KRX", "005930",
                    "20260518", "20260518"),
            "api_id": "ka10080",
            "priority": "user_visible",
        }
    ]
    assert result.cached_dates == ["20260517"]
    assert result.fresh_dates == ["20260518"]
    assert len(result.candles) == 1
    assert result.data_warnings == []


@pytest.mark.asyncio
async def test_collect_minute_treats_non_trading_empty_as_covered_for_fallback(tmp_path, monkeypatch, kiwoom) -> None:
    from hoga.api import calendar as cal

    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
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
async def test_live_minute_candle_backfill_reports_capacity_overload(tmp_path, kiwoom) -> None:
    kiwoom(_FakeWalk())
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


# `test_fetch_past_shared_corider_survives_waiter_cancellation` 은
# `tests/unit/live/test_kiwoom_capacity.py` 로 이사했다. PR-G(#1043)에서 날짜별
# single-flight 가 사라지고 중복제거가 **거버너**(`KiwoomCapacityScheduler`)로
# 올라갔기 때문이다 — 성질(대기자 취소가 코라이더를 죽이면 안 된다)은 그대로다.


@pytest.mark.asyncio
async def test_collect_minute_caps_uncached_fetches_per_request(tmp_path, monkeypatch, kiwoom) -> None:
    """예산(3)보다 큰 미캐시 창(10일) → 최신 3일만 fetch, 나머지는 budget 경고로 유예."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
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
    # **콜이 3개가 아니라 1개다** — walk 한 번이 구간을 덮는다(ADR-0136 §3).
    assert kis.calls == [("005930", "20260508", "20260510", "KRX")]
    warned = [w for w in result.data_warnings if w["reason"] == "fetch_budget_exhausted"]
    assert [w["date"] for w in warned] == [f"2026050{d}" for d in range(1, 8)]


@pytest.mark.asyncio
async def test_budget_counts_only_uncached_dates(tmp_path, monkeypatch, kiwoom) -> None:
    """캐시된 날짜는 예산을 소모하지 않는다."""
    from hoga.api import calendar as cal

    monkeypatch.setattr(cal, "is_trading_day", lambda date_s: True)
    kis = kiwoom(_FakeWalk())
    scheduler = _RecordingScheduler()
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
    assert kis.calls == [("005930", "20260508", "20260510", "KRX")], (
        "캐시된 앞구간은 walk 구간에서 빠진다"
    )


@pytest.mark.asyncio
async def test_transport_failure_keeps_its_own_reason(tmp_path, kiwoom) -> None:
    """전송 실패는 `transport_error` 로 나간다 — `api_error` 로 접지 않는다.

    이전 판은 `except KiwoomRestError` 팔이 전부 `api_error` 였다. 그래서 프론트가
    진짜 전송 실패를 가려내려고 `msg` 에서 `'TRANSPORT/'` 문자열을 뒤져야 했다 —
    벤더 거절(기다린다)과 회선 끊김(점검한다)은 처방이 다른데 같은 얼굴이었다
    (ADR-0137).
    """
    import httpx

    from hoga.live.kiwoom_errors import KiwoomTransportError

    fake = _FakeWalk()

    async def _boom(*_a, **_kw):
        raise KiwoomTransportError(httpx.ConnectTimeout("timed out"))

    fake.walk = _boom          # type: ignore[method-assign]
    kiwoom(fake)
    backfill = LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(),  # type: ignore[arg-type]
        concurrency=1,
    )

    result = await backfill.collect_minute(
        code="005930",
        frm=dt.date(2026, 5, 18),
        too=dt.date(2026, 5, 18),
        today_d=dt.date(2026, 6, 1),
        policy="KRX",
    )

    assert [w["reason"] for w in result.data_warnings] == ["transport_error"]
    assert "TRANSPORT/" not in result.data_warnings[0]["msg"], (
        "사유가 정확해졌으므로 프론트가 msg 를 파싱할 이유가 없다"
    )


def test_fallback_blocking_reasons_cover_every_rest_error_reason() -> None:
    """**폴백 계약과 표시 계약이 같은 문자열을 공유한다.**

    `_rest_error_warning` 이 내는 사유가 `_FALLBACK_BLOCKING_REASONS` 에서 빠지면,
    막아야 할 날짜가 '안 막힌 날짜' 로 분류되어 NXT/UN → KRX 재조회가 조용히 켜진다.
    사유를 세분화할 때 여기를 함께 넓혔는지 이 테스트가 못 박는다.
    """
    import httpx

    from hoga.live.kiwoom_errors import (
        KiwoomApiError,
        KiwoomAuthError,
        KiwoomBatchLimitError,
        KiwoomTransportError,
    )
    from hoga.live.live_candle_backfill import (
        _FALLBACK_BLOCKING_REASONS,
        _rest_error_warning,
    )

    for exc in (
        KiwoomTransportError(httpx.ConnectTimeout("x")),
        KiwoomAuthError("no token"),
        KiwoomBatchLimitError(code=5, msg="1634"),
        KiwoomApiError(code=3, msg="rejected"),
        KiwoomRestError("module-specific"),
    ):
        reason = _rest_error_warning("20260518", exc)["reason"]
        assert reason in _FALLBACK_BLOCKING_REASONS, (
            f"{type(exc).__name__} → {reason!r} 이 폴백 차단 집합에 없다"
        )
