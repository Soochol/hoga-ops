"""키움 분봉 딥 백필 통합 — range prefetch 키움우선→KIS폴백 (ADR-0116, PR-5b)."""
import asyncio
import datetime as dt

import pytest

from hoga.api import calendar as cal
from hoga.live.kis_models import KisCandle
from hoga.live.live_candle_backfill import LiveMinuteCandleBackfill
from hoga.live.past_candles_cache import PastCandlesCache


def _kst_ms(date_yyyymmdd: str, hour: int = 9, minute: int = 0) -> int:
    kst = dt.timezone(dt.timedelta(hours=9))
    return int(dt.datetime(
        int(date_yyyymmdd[:4]), int(date_yyyymmdd[4:6]), int(date_yyyymmdd[6:8]),
        hour, minute, tzinfo=kst,
    ).timestamp() * 1000)


class _FakeKis:
    def __init__(self):
        self.calls = []

    async def fetch_past_minute_candles(self, code, date_yyyymmdd, *, venue=None, foreground=None):
        self.calls.append((code, date_yyyymmdd))
        return [KisCandle(t_ms=_kst_ms(date_yyyymmdd), open=1, high=1, low=1, close=1, volume=1)]


class _RecordingScheduler:
    def __init__(self, kis):
        self.kis = kis

    async def submit(self, *, key, endpoint, priority, call, cooldown_scope=None):
        return await call(self.kis)


class _FakeKiwoom:
    """지정 날짜 집합에 대해 캔들을 반환하는 walk-back 페처. complete=완결 도달 여부."""
    def __init__(self, dates, *, complete=True):
        self._dates = dates
        self._complete = complete
        self.calls = []

    async def fetch_minute_candles(self, code, *, until_date=None, max_pages=20):
        self.calls.append((code, until_date))
        candles = [
            KisCandle(t_ms=_kst_ms(d, 9, i), open=1, high=1, low=1, close=1, volume=1)
            for d in self._dates for i in range(2)
        ]
        return candles, self._complete


def _backfill(tmp_path, kis, *, kiwoom=None):
    return LiveMinuteCandleBackfill(
        data_dir=tmp_path,
        cache=PastCandlesCache(data_dir=tmp_path),
        scheduler=_RecordingScheduler(kis),  # type: ignore[arg-type]
        concurrency=1,
        kiwoom_source=(lambda: kiwoom) if kiwoom is not None else None,
    )


@pytest.fixture(autouse=True)
def _all_trading(monkeypatch):
    monkeypatch.setattr(cal, "is_trading_day", lambda _d: True)
    # 지평선 판정용 — 기본은 짧은 span(도달권 내)이라 prefetch 진행. 딥팬 테스트가 오버라이드.
    monkeypatch.setattr(cal, "trading_days_in_range", lambda _s, _e: ["x"])


async def _collect_krx(backfill, dates):
    return await backfill._collect_for_venue(
        "KRX", code="005930",
        frm=dt.date(int(dates[0][:4]), int(dates[0][4:6]), int(dates[0][6:8])),
        too=dt.date(int(dates[-1][:4]), int(dates[-1][4:6]), int(dates[-1][6:8])),
        today_d=dt.date(2026, 6, 1),
    )


async def test_kiwoom_fills_range_and_kis_not_called(tmp_path):
    tmp = tmp_path
    kis = _FakeKis()
    kiwoom = _FakeKiwoom(["20260518", "20260519", "20260520"])
    bf = _backfill(tmp, kis, kiwoom=kiwoom)
    result = await _collect_krx(bf, ["20260518", "20260520"])
    # 키움이 range를 한 walk-back(until_date=최과거)으로 채움 → KIS 미호출.
    assert kiwoom.calls == [("005930", "20260518")]
    assert kis.calls == []
    assert set(result.cached_dates) == {"20260518", "20260519", "20260520"}
    assert result.fresh_dates == []
    assert len(result.candles) == 6  # 3일 × 2봉


async def test_kis_fallback_for_dates_kiwoom_misses(tmp_path):
    tmp = tmp_path
    kis = _FakeKis()
    # 키움은 18·20만 반환, 19는 누락 → 19는 KIS 폴백.
    kiwoom = _FakeKiwoom(["20260518", "20260520"])
    bf = _backfill(tmp, kis, kiwoom=kiwoom)
    result = await _collect_krx(bf, ["20260518", "20260520"])
    assert kis.calls == [("005930", "20260519")]  # 갭만 KIS
    assert "20260519" in result.fresh_dates
    assert {"20260518", "20260520"} <= set(result.cached_dates)


async def test_kiwoom_incomplete_walkback_drops_boundary_date_to_kis(tmp_path):
    """리뷰 C3: walk-back 미완결(complete=False)이면 최과거 경계 날짜(18)는 부분 데이터라
    캐시에 저장 안 하고 KIS 폴백 — 나머지(19·20)만 키움 저장."""
    tmp = tmp_path
    kis = _FakeKis()
    kiwoom = _FakeKiwoom(["20260518", "20260519", "20260520"], complete=False)
    bf = _backfill(tmp, kis, kiwoom=kiwoom)
    result = await _collect_krx(bf, ["20260518", "20260520"])
    # 경계(최과거) 18은 부분 → KIS 폴백, 19·20은 키움 저장.
    assert kis.calls == [("005930", "20260518")]
    assert "20260518" in result.fresh_dates
    assert {"20260519", "20260520"} <= set(result.cached_dates)


async def test_kiwoom_failure_falls_back_entirely_to_kis(tmp_path):
    tmp = tmp_path

    class _Boom:
        calls = []
        async def fetch_minute_candles(self, code, *, until_date=None, max_pages=20):
            raise RuntimeError("kiwoom down")

    kis = _FakeKis()
    bf = _backfill(tmp, kis, kiwoom=_Boom())
    result = await _collect_krx(bf, ["20260518", "20260518"])
    # 키움 예외 → 전량 KIS 폴백(사다리).
    assert kis.calls == [("005930", "20260518")]
    assert "20260518" in result.fresh_dates


async def test_no_kiwoom_source_unchanged_all_kis(tmp_path):
    tmp = tmp_path
    kis = _FakeKis()
    bf = _backfill(tmp, kis, kiwoom=None)  # 미배선
    result = await _collect_krx(bf, ["20260518", "20260518"])
    assert kis.calls == [("005930", "20260518")]
    assert "20260518" in result.fresh_dates


async def test_kiwoom_prefetch_skips_non_krx_venue(tmp_path):
    tmp = tmp_path
    kiwoom = _FakeKiwoom(["20260518"])
    bf = _backfill(tmp, _FakeKis(), kiwoom=kiwoom)
    await bf._kiwoom_prefetch("NXT", "005930", ["20260518"], today_s="20260601")
    assert kiwoom.calls == []  # NXT는 키움 대상 아님(ka10080=KRX 캔들)


async def test_kiwoom_prefetch_skips_deep_pan_beyond_horizon(tmp_path, monkeypatch):
    """리뷰 Major: pending 최과거가 walk-back 도달권(~46거래일)을 넘으면 prefetch 스킵 —
    20페이지 소진해도 못 닿아 ~20s 낭비. 즉시 KIS 폴백에 맡긴다."""
    monkeypatch.setattr(cal, "trading_days_in_range", lambda _s, _e: ["d"] * 50)  # >46
    kiwoom = _FakeKiwoom(["20260101"])
    bf = _backfill(tmp_path, _FakeKis(), kiwoom=kiwoom)
    await bf._kiwoom_prefetch("KRX", "005930", ["20260101"], today_s="20260601")
    assert kiwoom.calls == []  # 지평선 밖 → walk-back 아예 시도 안 함


async def test_kiwoom_prefetch_within_horizon_still_fetches(tmp_path, monkeypatch):
    monkeypatch.setattr(cal, "trading_days_in_range", lambda _s, _e: ["d"] * 46)  # ==reach
    kiwoom = _FakeKiwoom(["20260518"])
    bf = _backfill(tmp_path, _FakeKis(), kiwoom=kiwoom)
    await bf._kiwoom_prefetch("KRX", "005930", ["20260518"], today_s="20260601")
    assert kiwoom.calls == [("005930", "20260518")]  # 도달권 경계는 진행


async def test_kiwoom_prefetch_single_flight_dedups_concurrent(tmp_path):
    """리뷰 Major: 같은 (venue, code)의 동시 collect가 walk-back을 중복하지 않는다 —
    Lock으로 직렬화, 두 번째는 첫 번째가 채운 캐시를 보고 재수집 안 함."""

    class _SlowKiwoom(_FakeKiwoom):
        async def fetch_minute_candles(self, code, *, until_date=None, max_pages=20):
            await asyncio.sleep(0)  # 양보 — 두 코루틴이 락에서 경합하도록
            return await super().fetch_minute_candles(code, until_date=until_date)

    kiwoom = _SlowKiwoom(["20260518", "20260519"])
    bf = _backfill(tmp_path, _FakeKis(), kiwoom=kiwoom)
    pending = ["20260518", "20260519"]
    await asyncio.gather(
        bf._kiwoom_prefetch("KRX", "005930", pending, today_s="20260601"),
        bf._kiwoom_prefetch("KRX", "005930", pending, today_s="20260601"),
    )
    assert len(kiwoom.calls) == 1  # 한 번만 walk-back(single-flight)
