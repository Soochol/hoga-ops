"""ProgramTradeCollector — 키움 0w latch drain → store 병합 (PR-F4).

REST 시절의 계약 중 루프·게이트·에러 관측은 유지되고, fetch 는 latch drain 으로
바뀌었다. latch payload 는 kiwoom_frames._parse_program 산출 shape 을 흉내낸다.
"""
import asyncio

import pytest

from hoga.live import program_trade_latch
from hoga.live.program_trade_collector import ProgramTradeCollector


@pytest.fixture(autouse=True)
def _clean_latch():
    program_trade_latch.reset_for_tests()
    yield
    program_trade_latch.reset_for_tests()


def _payload(*, t_ms=1_784_521_985_000, sell_qty=100, sell_amount=5_000_000,
             buy_qty=150, buy_amount=7_500_000, net_qty=50, net_amount=2_500_000,
             price=50_000):
    """_parse_program 산출 shape (금액은 이미 원 단위 정규화 후)."""
    return {
        "code": "005930", "t_ms": t_ms,
        "sell_qty": sell_qty, "sell_amount": sell_amount,
        "buy_qty": buy_qty, "buy_amount": buy_amount,
        "net_qty": net_qty, "net_amount": net_amount, "price": price,
    }


def _collector(tmp_path, *, date="20260720", should_collect=True):
    return ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: date,
        now_ms_fn=lambda: 1000,
        should_collect_fn=lambda _now_ms: should_collect,
    )


@pytest.mark.asyncio
async def test_drains_latch_into_store(tmp_path):
    program_trade_latch.update("005930", _payload())
    collector = _collector(tmp_path)

    await collector.run_once()

    stored = collector.store.load("005930", "20260720")
    assert len(stored.rows) == 1
    row = stored.rows[0]
    # bsop_hour = 수신 t_ms 의 KST HHMMSS (2026-07-20 13:33:05 KST).
    assert row.bsop_hour == "133305"
    assert row.net_qty == 50
    assert row.net_amount == 2_500_000
    assert row.buy_qty == 150 and row.sell_qty == 100
    assert collector.status.targets == ("005930",)
    # drain 이 latch 를 비웠으므로 다음 사이클은 재병합하지 않는다.
    await collector.run_once()
    assert len(collector.store.load("005930", "20260720").rows) == 1


@pytest.mark.asyncio
async def test_derives_delta_from_cumulative_net_across_flushes(tmp_path):
    """delta 는 0w 의 211/213(이벤트 증감, 재전송 취약)이 아니라 flush 간 누적
    diff 로 파생한다 — F3 권고. 첫 flush 는 기준이 없어 None."""
    collector = _collector(tmp_path)

    program_trade_latch.update("005930", _payload(net_qty=50, net_amount=2_500_000))
    await collector.run_once()
    program_trade_latch.update(
        "005930", _payload(t_ms=1_784_522_045_000, net_qty=80, net_amount=4_100_000))
    await collector.run_once()

    rows = collector.store.load("005930", "20260720").rows
    assert [r.delta_qty for r in rows] == [None, 30]
    assert [r.delta_amount for r in rows] == [None, 1_600_000]


@pytest.mark.asyncio
async def test_delta_baseline_resets_on_new_trading_day(tmp_path):
    """날짜가 바뀌면 전일 누적 대비 delta(음수 폭주)를 만들지 않는다."""
    current = {"d": "20260720"}
    collector = ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: current["d"],
        now_ms_fn=lambda: 1000,
        should_collect_fn=lambda _now_ms: True,
    )

    program_trade_latch.update("005930", _payload(net_qty=1_000_000))
    await collector.run_once()
    current["d"] = "20260721"
    program_trade_latch.update("005930", _payload(net_qty=10))
    await collector.run_once()

    rows = collector.store.load("005930", "20260721").rows
    assert rows[0].delta_qty is None  # 전일(1,000,000) 대비 -999,990 이 아니라 리셋


@pytest.mark.asyncio
async def test_skips_when_market_window_closed_but_keeps_latch(tmp_path):
    """게이트 닫힘이면 병합하지 않는다 — latch 는 비우지 않아 개장 후 첫 사이클이
    마지막 스냅샷을 병합한다."""
    program_trade_latch.update("005930", _payload())
    collector = _collector(tmp_path, should_collect=False)

    await collector.run_once()

    assert collector.store.path("005930", "20260720").exists() is False
    assert collector.status.last_cycle_ms == 1000
    # latch 보존 확인 — 게이트가 열리면 병합된다.
    collector._should_collect_fn = lambda _now_ms: True
    await collector.run_once()
    assert collector.store.path("005930", "20260720").exists() is True


@pytest.mark.asyncio
async def test_per_code_failure_stays_local(tmp_path):
    program_trade_latch.update("005930", _payload())
    bad = _payload()
    bad["t_ms"] = "not-a-number"  # _to_row 에서 int() 실패 유도
    program_trade_latch.update("000660", bad)
    collector = _collector(tmp_path)

    await collector.run_once()

    assert collector.status.last_error_count == 1
    assert "000660" in (collector.status.last_error or "")
    # 정상 코드는 저장됐다.
    assert len(collector.store.load("005930", "20260720").rows) == 1


@pytest.mark.asyncio
async def test_loop_failure_sets_internal_kind_and_keeps_running(tmp_path, caplog):
    collector = _collector(tmp_path)

    def _boom():
        raise RuntimeError("date failed")

    collector._date_fn = _boom
    with caplog.at_level("ERROR", logger="hoga.live.program_trade_collector"):
        collector.start()
        try:
            for _ in range(50):
                await asyncio.sleep(0.01)
                if collector.status.last_error_kind == "internal":
                    break
            assert collector.status.running is True
            assert collector.status.last_error_kind == "internal"
            assert collector.status.last_error_code == "RuntimeError"
        finally:
            await collector.stop()
