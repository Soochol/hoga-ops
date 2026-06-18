import datetime
import pytest
from hoga.api import screener as screener_mod
from hoga.api.screener import fetch_screener_daily_bars_via_queue
from hoga.api.screener_store import DailyBar
from hoga.live.kis_client import DailyCandleFetchResult
from hoga.live.kis_models import KisCandle


class _FakeQueue:
    def __init__(self, candles):
        self._candles = candles
        self.calls = []

    async def fetch_past_daily_candles(
        self, data_dir, *, lane, code, from_yyyymmdd, to_yyyymmdd, adjust,
    ):
        self.calls.append((data_dir, lane, code, from_yyyymmdd, to_yyyymmdd, adjust))
        return DailyCandleFetchResult(candles=self._candles, violations=[])


@pytest.mark.asyncio
async def test_kis_adapter_converts_shape(monkeypatch, tmp_path):
    fake = _FakeQueue([
        KisCandle(t_ms=1778716800000, open=100, high=120, low=90, close=110, volume=5)
    ])
    monkeypatch.setattr(screener_mod, "get_daily_fetch_queue", lambda: fake)

    rows = await fetch_screener_daily_bars_via_queue(
        tmp_path, "000001", "20260514", "20260514",
    )
    r = rows[0]
    assert isinstance(r, DailyBar)
    assert r.code == "000001"
    assert isinstance(r.open, float) and r.open == 100.0   # int→float 위드닝
    assert isinstance(r.date, datetime.date)                # date 객체
    assert fake.calls == [(tmp_path, "background", "000001", "20260514", "20260514", False)]


@pytest.mark.asyncio
async def test_kis_adapter_maps_dailybar_fields(monkeypatch, tmp_path):
    """queue-backed adapter가 DailyCandleFetchResult → list[DailyBar] 를 올바르게 매핑하는지 검증.
    code 전파, t_ms→date(KIS_KST), ohlcv float/int 위드닝 모두 포함."""
    # 2026-05-14 09:00 KST = 2026-05-14 00:00 UTC → epoch ms 1778716800000
    # 2026-05-15 09:00 KST = 2026-05-15 00:00 UTC → epoch ms 1778803200000
    candles = [
        KisCandle(t_ms=1778716800000, open=100, high=120, low=90,  close=110, volume=5000),
        KisCandle(t_ms=1778803200000, open=111, high=130, low=105, close=125, volume=3000),
    ]
    fake = _FakeQueue(candles)
    monkeypatch.setattr(screener_mod, "get_daily_fetch_queue", lambda: fake)

    bars = await fetch_screener_daily_bars_via_queue(
        tmp_path, "005930", "20260514", "20260515",
    )

    assert len(bars) == 2

    b0, b1 = bars
    # 타입 계약
    assert all(isinstance(b, DailyBar) for b in bars)
    # code 전파
    assert b0.code == "005930" and b1.code == "005930"
    # t_ms → date (KIS_KST 기준 09:00 앵커 → 당일 date)
    assert b0.date == datetime.date(2026, 5, 14)
    assert b1.date == datetime.date(2026, 5, 15)
    # ohlcv — int→float 위드닝, volume 은 int
    assert b0.open == 100.0 and isinstance(b0.open, float)
    assert b0.high == 120.0 and isinstance(b0.high, float)
    assert b0.low  == 90.0  and isinstance(b0.low,  float)
    assert b0.close == 110.0 and isinstance(b0.close, float)
    assert b0.volume == 5000 and isinstance(b0.volume, int)
    assert b1.close == 125.0 and b1.volume == 3000
