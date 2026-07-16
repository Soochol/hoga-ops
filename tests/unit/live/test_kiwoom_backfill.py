"""키움 분봉 딥 백필 통합 — range prefetch 키움우선→KIS폴백 (ADR-0116, PR-5b)."""
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
    """지정 날짜 집합에 대해 캔들을 반환하는 walk-back 페처."""
    def __init__(self, dates):
        self._dates = dates
        self.calls = []

    async def fetch_minute_candles(self, code, *, until_date=None, max_pages=20):
        self.calls.append((code, until_date))
        return [
            KisCandle(t_ms=_kst_ms(d, 9, i), open=1, high=1, low=1, close=1, volume=1)
            for d in self._dates for i in range(2)
        ]


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
    await bf._kiwoom_prefetch("NXT", "005930", ["20260518"])
    assert kiwoom.calls == []  # NXT는 키움 대상 아님(ka10080=KRX 캔들)
