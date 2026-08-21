"""ProgramTradeCollector — 키움 0w latch drain → store 병합 (PR-F4).

REST 시절의 계약 중 루프·게이트·에러 관측은 유지되고, fetch 는 latch drain 으로
바뀌었다. latch payload 는 kiwoom_frames._parse_program 산출 shape 을 흉내낸다.
"""
import asyncio
import threading

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


ALL_VENUES = frozenset({"KRX", "NXT", "UN"})


def _open_venues_fn(venues):
    async def _fn(_now_ms):
        return frozenset(venues)
    return _fn


def _collector(tmp_path, *, date="20260720", open_venues=ALL_VENUES):
    return ProgramTradeCollector(
        data_dir=tmp_path,
        date_fn=lambda: date,
        now_ms_fn=lambda: 1000,
        open_venues_fn=_open_venues_fn(open_venues),
    )


@pytest.mark.asyncio
async def test_drains_latch_into_store(tmp_path):
    program_trade_latch.update("005930", _payload(), venue="KRX")
    collector = _collector(tmp_path)

    await collector.run_once()

    stored = collector.store.load("005930", "20260720", "KRX")
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
    assert len(collector.store.load("005930", "20260720", "KRX").rows) == 1


@pytest.mark.asyncio
async def test_derives_delta_from_cumulative_net_across_flushes(tmp_path):
    """delta 는 0w 의 211/213(이벤트 증감, 재전송 취약)이 아니라 flush 간 누적
    diff 로 파생한다 — F3 권고. 첫 flush 는 기준이 없어 None."""
    collector = _collector(tmp_path)

    program_trade_latch.update("005930", _payload(net_qty=50, net_amount=2_500_000), venue="KRX")
    await collector.run_once()
    program_trade_latch.update(
        "005930", _payload(t_ms=1_784_522_045_000, net_qty=80, net_amount=4_100_000), venue="KRX")
    await collector.run_once()

    rows = collector.store.load("005930", "20260720", "KRX").rows
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
        open_venues_fn=_open_venues_fn(ALL_VENUES),
    )

    program_trade_latch.update("005930", _payload(net_qty=1_000_000), venue="KRX")
    await collector.run_once()
    current["d"] = "20260721"
    program_trade_latch.update("005930", _payload(net_qty=10), venue="KRX")
    await collector.run_once()

    rows = collector.store.load("005930", "20260721", "KRX").rows
    assert rows[0].delta_qty is None  # 전일(1,000,000) 대비 -999,990 이 아니라 리셋


@pytest.mark.asyncio
async def test_skips_when_market_window_closed_but_keeps_latch(tmp_path):
    """게이트 닫힘이면 병합하지 않는다 — latch 는 비우지 않아 개장 후 첫 사이클이
    마지막 스냅샷을 병합한다."""
    program_trade_latch.update("005930", _payload(), venue="KRX")
    collector = _collector(tmp_path, open_venues=frozenset())

    await collector.run_once()

    assert collector.store.path("005930", "20260720", "KRX").exists() is False
    assert collector.status.last_cycle_ms == 1000
    # latch 보존 확인 — 게이트가 열리면 병합된다.
    collector._open_venues_fn = _open_venues_fn(ALL_VENUES)
    await collector.run_once()
    assert collector.store.path("005930", "20260720", "KRX").exists() is True


# ── venue 별 수집 (ADR-0140 §3) ────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stores_each_venue_in_its_own_file(tmp_path):
    """세 시장이 한 파일에 섞이지 않는다 — 섞이면 되돌릴 수 없다."""
    program_trade_latch.update("005930", _payload(net_qty=50), venue="KRX")
    program_trade_latch.update("005930", _payload(net_qty=70), venue="NXT")
    program_trade_latch.update("005930", _payload(net_qty=120), venue="UN")
    collector = _collector(tmp_path)

    await collector.run_once()

    nets = {
        v: collector.store.load("005930", "20260720", v).rows[0].net_qty
        for v in ("KRX", "NXT", "UN")
    }
    assert nets == {"KRX": 50, "NXT": 70, "UN": 120}
    assert collector.status.targets == ("005930",)  # 코드 단위 관측은 중복 제거


@pytest.mark.asyncio
async def test_only_open_venues_are_stored(tmp_path):
    """창은 venue 마다 다르다 — KRX 정규장이 닫힌 애프터마켓엔 NXT·UN 만 쌓인다.

    이 테스트가 이 PR 의 요점이다: 예전엔 게이트가 KRX 정규장 하나였고 KRX 태그만
    병합해, 15:30 이후 프로그램 순매수가 **어디에도 남지 않았다**.
    """
    program_trade_latch.update("005930", _payload(net_qty=50), venue="KRX")
    program_trade_latch.update("005930", _payload(net_qty=70), venue="NXT")
    collector = _collector(tmp_path, open_venues=frozenset({"NXT", "UN"}))

    await collector.run_once()

    assert collector.store.path("005930", "20260720", "NXT").exists() is True
    assert collector.store.path("005930", "20260720", "KRX").exists() is False


@pytest.mark.asyncio
async def test_delta_baseline_is_per_venue(tmp_path):
    """delta 는 같은 시장의 직전 값과의 차이다 — code 로만 키잉하면 도착 순서에 따라
    **다른 시장 사이의 뺄셈**이 되어 부호까지 뒤집힌다."""
    collector = _collector(tmp_path)

    program_trade_latch.update("005930", _payload(net_qty=1_000), venue="KRX")
    program_trade_latch.update("005930", _payload(net_qty=10), venue="NXT")
    await collector.run_once()
    program_trade_latch.update(
        "005930", _payload(t_ms=1_784_522_045_000, net_qty=1_030), venue="KRX")
    program_trade_latch.update(
        "005930", _payload(t_ms=1_784_522_045_000, net_qty=25), venue="NXT")
    await collector.run_once()

    krx = collector.store.load("005930", "20260720", "KRX").rows
    nxt = collector.store.load("005930", "20260720", "NXT").rows
    assert [r.delta_qty for r in krx] == [None, 30]    # 1,030 - 1,000
    assert [r.delta_qty for r in nxt] == [None, 15]    # 25 - 10 (KRX 와 섞이지 않는다)


@pytest.mark.asyncio
async def test_per_code_failure_stays_local(tmp_path):
    program_trade_latch.update("005930", _payload(), venue="KRX")
    bad = _payload()
    bad["t_ms"] = "not-a-number"  # _to_row 에서 int() 실패 유도
    program_trade_latch.update("000660", bad, venue="KRX")
    collector = _collector(tmp_path)

    await collector.run_once()

    assert collector.status.last_error_count == 1
    assert "000660" in (collector.status.last_error or "")
    # 정상 코드는 저장됐다.
    assert len(collector.store.load("005930", "20260720", "KRX").rows) == 1


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


@pytest.mark.asyncio
async def test_merge_runs_off_the_event_loop_thread(tmp_path):
    """병합은 **이벤트 루프 스레드에서 돌면 안 된다**.

    막는 방향: `run_once` 가 `store.merge_response` 를 직접(동기로) 부르는 회귀.
    이 앱은 `--workers` 를 못 써서 단일 루프가 REST·WS·스케줄러를 전부 처리하므로
    (#998), 여기서 직렬로 도는 파일 읽기 + fsync 쓰기가 그대로 전역 정지가 된다
    (2026-08-21 실측: 32.3초 주기로 2.0~2.6초, 최대 11.2초).

    **못 보는 것**: 스레드로 넘겼더라도 총 IO 량이 크면 GIL 경합으로 루프가 느려지는
    것까지는 막지 못한다 — 그 축은 `loop-lag-probe`(`hoga_perf loop_lag`)가 잰다.
    """
    program_trade_latch.update("005930", _payload(), venue="KRX")
    collector = _collector(tmp_path)
    loop_thread = threading.get_ident()
    seen: list[int] = []
    real = collector.store.merge_response

    def _spy(**kwargs):
        seen.append(threading.get_ident())
        return real(**kwargs)

    collector.store.merge_response = _spy

    await collector.run_once()

    assert seen, "merge_response 가 불리지 않았다 — latch 픽스처가 비어 있다"
    assert all(t != loop_thread for t in seen), (
        "merge_response 가 이벤트 루프 스레드에서 실행됐다 — to_thread 우회 회귀"
    )
    # 병합 자체는 그대로 성립해야 한다(스레드로 옮겼을 뿐이다).
    assert len(collector.store.load("005930", "20260720", "KRX").rows) == 1
