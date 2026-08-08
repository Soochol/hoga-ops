"""스크리너 일봉 형변환 어댑터 — PR-F(#1042) 이후 소스는 키움 `ka10081` 이다.

이 파일이 보는 것은 **형변환 계약**(`LiveCandle` → `DailyBar`)이지 벤더 와이어가
아니다. 그래서 페이크는 어댑터 함수 자리에 꽂고, 와이어 파싱은
`tests/unit/live/test_kiwoom_daily_candles.py` 가 실측 행으로 덮는다.
"""
import datetime

import pytest

from hoga.api.screener import _daily_fetch_one
from hoga.api.screener_store import DailyBar
from hoga.live import kiwoom_daily_candles
from hoga.live.candle_fetch_result import DailyCandleFetchResult
from hoga.live.candle_models import LiveCandle


async def _fake_page_fetch(_client):
    """페이크가 러너에 넘기는 페이지 팩토리 — 거버너 경로만 지나게 한다(ADR-0137)."""
    from hoga.live.kiwoom_rest import Page

    return Page(rows=[], cont=False, next_key="")

@pytest.fixture
def stub_daily(monkeypatch):
    """어댑터가 돌려줄 캔들을 심는다. `adjust=False`(원주가)도 함께 못 박는다."""
    def _install(candles):
        seen = {}

        async def _fetch(_client, code, frm, to, *, venue="KRX", adjust,
                         adjusted_as_of, run_page=None):
            seen["adjust"] = adjust
            seen["adjusted_as_of"] = adjusted_as_of
            if run_page is not None:
                await run_page(_fake_page_fetch, 0)
            return DailyCandleFetchResult(candles=candles, violations=[])

        monkeypatch.setattr(kiwoom_daily_candles, "fetch_daily_candles", _fetch)
        return seen

    return _install


@pytest.mark.asyncio
async def test_daily_adapter_converts_shape(stub_daily):
    seen = stub_daily(
        [LiveCandle(t_ms=1778716800000, open=100, high=120, low=90, close=110, volume=5)]
    )
    rows = await _daily_fetch_one(object(), "000001", "20260514", "20260514")
    assert seen["adjust"] is False, "스크리너 코퍼스는 원주가다"
    assert seen["adjusted_as_of"] is None, (
        "원주가는 절대값이라 수정주가 기준일이 없다 — 여기에 날짜를 주면 "
        "오늘부터 걸어 내려오느라 페이지만 낭비한다(함정 ④)"
    )
    r = rows[0]
    assert isinstance(r, DailyBar)
    assert r.code == "000001"
    assert isinstance(r.open, float) and r.open == 100.0   # int→float 위드닝
    assert isinstance(r.date, datetime.date)                # date 객체


@pytest.mark.asyncio
async def test_daily_adapter_maps_dailybar_fields(stub_daily):
    """_daily_fetch_one 이 DailyCandleFetchResult → list[DailyBar] 를 올바르게 매핑하는지 검증.
    code 전파, t_ms→date(KST), ohlcv float/int 위드닝 모두 포함."""
    # 2026-05-14 09:00 KST = 2026-05-14 00:00 UTC → epoch ms 1778716800000
    # 2026-05-15 09:00 KST = 2026-05-15 00:00 UTC → epoch ms 1778803200000
    candles = [
        LiveCandle(t_ms=1778716800000, open=100, high=120, low=90,  close=110, volume=5000),
        LiveCandle(t_ms=1778803200000, open=111, high=130, low=105, close=125, volume=3000),
    ]
    stub_daily(candles)
    bars = await _daily_fetch_one(object(), "005930", "20260514", "20260515")

    assert len(bars) == 2

    b0, b1 = bars
    # 타입 계약
    assert all(isinstance(b, DailyBar) for b in bars)
    # code 전파
    assert b0.code == "005930" and b1.code == "005930"
    # t_ms → date (KST 기준 09:00 앵커 → 당일 date)
    assert b0.date == datetime.date(2026, 5, 14)
    assert b1.date == datetime.date(2026, 5, 15)
    # ohlcv — int→float 위드닝, volume 은 int
    assert b0.open == 100.0 and isinstance(b0.open, float)
    assert b0.high == 120.0 and isinstance(b0.high, float)
    assert b0.low  == 90.0  and isinstance(b0.low,  float)
    assert b0.close == 110.0 and isinstance(b0.close, float)
    assert b0.volume == 5000 and isinstance(b0.volume, int)
    assert b1.close == 125.0 and b1.volume == 3000
