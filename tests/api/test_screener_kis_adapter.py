import pytest
from hoga.api.screener import _kis_fetch_one
from hoga.live.kis_models import KisCandle


class _FakeRes:
    def __init__(self, candles): self.candles = candles; self.violations = []

class _FakeClient:
    async def fetch_past_daily_candles(self, code, frm, to, *, adjust):
        assert adjust is False                       # 스크리너는 원주가
        # 2026-05-14 09:00 KST epoch ms 근처
        return _FakeRes([KisCandle(t_ms=1778716800000, open=100, high=120, low=90, close=110, volume=5)])


@pytest.mark.asyncio
async def test_kis_adapter_converts_shape():
    rows = await _kis_fetch_one(_FakeClient(), "000001", "20260514", "20260514")
    r = rows[0]
    assert r["code"] == "000001"
    assert isinstance(r["open"], float) and r["open"] == 100.0   # int→float 위드닝
    assert isinstance(r["date"], __import__("datetime").date)     # date 객체
