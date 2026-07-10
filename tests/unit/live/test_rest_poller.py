"""Unit tests for LiveRestPoller (ADR-0067 보는종목 REST 표시폴러).

ADR-0067: activeCode가 WS live_set 밖이면 2초 주기 REST 폴링 → buffer.publish.
ADR-0064: 루프 예외 격리 + alive = task.done() 기반(거짓 health 금지).
저장 경로(writer/promote/to_jsonl) 호출 금지.
"""
from __future__ import annotations

import asyncio
import contextlib
import time

import pytest

from hoga.live.buffer import LiveBuffer
from hoga.live.kis_models import KisBrokerEntry, KisBrokers, KisOrderbook, KisTrade, OrderbookLevel
from hoga.live.rest_poller import LiveRestPoller


# ── Fake KIS client ────────────────────────────────────────────────────────────

class FakeKisClient:
    """Minimal fake for LiveRestPoller tests.

    - Returns minimal valid models for each fetch method.
    - If a code is in `raise_for`, all three fetch methods raise RuntimeError.
    - Records per-method call counts via `calls` dict.
    """

    def __init__(self, *, raise_for: set[str] | None = None) -> None:
        self.raise_for: set[str] = raise_for or set()
        self.calls: dict[str, list[str]] = {
            "fetch_orderbook": [],
            "fetch_trades": [],
            "fetch_brokers": [],
        }

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        self.calls["fetch_orderbook"].append(code)
        if code in self.raise_for:
            raise RuntimeError(f"fake fetch_orderbook error for {code}")
        now_ms = int(time.time() * 1000)
        return KisOrderbook(
            code=code,
            asks=[OrderbookLevel(price=70000, qty=100)],
            bids=[OrderbookLevel(price=69900, qty=200)],
            total_ask_qty=100,
            total_bid_qty=200,
            t_ms=now_ms,
        )

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        self.calls["fetch_trades"].append(code)
        if code in self.raise_for:
            raise RuntimeError(f"fake fetch_trades error for {code}")
        now_ms = int(time.time() * 1000)
        return [
            KisTrade(price=70000, qty=10, side=1, side_source="inferred", t_ms=now_ms),
        ]

    async def fetch_brokers(self, code: str) -> KisBrokers:
        self.calls["fetch_brokers"].append(code)
        if code in self.raise_for:
            raise RuntimeError(f"fake fetch_brokers error for {code}")
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="미래에셋", qty=500)],
            sell_top=[KisBrokerEntry(name="키움", qty=300)],
        )


# ── Helper ─────────────────────────────────────────────────────────────────────

def _make_poller(
    *,
    raise_for: set[str] | None = None,
    interval_s: float = 0.02,
    phase_fn=None,
    capture_aux: bool = False,
) -> tuple[FakeKisClient, LiveBuffer, LiveRestPoller]:
    kis = FakeKisClient(raise_for=raise_for)
    buf = LiveBuffer()
    poller = LiveRestPoller(
        lambda: kis,  # resolver: 매 사이클 동일 fake 반환
        buf,
        interval_s=interval_s,
        phase_fn=phase_fn or (lambda: "regular"),
        capture_aux=capture_aux,
    )
    return kis, buf, poller


# ── Tests ──────────────────────────────────────────────────────────────────────


async def test_on_subscribe_adds_code():
    """on_subscribe(code)가 구독 목록에 추가된다."""
    _, _, poller = _make_poller()
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")
    assert "005930" in poller._subscribed
    assert "000660" in poller._subscribed


async def test_on_unsubscribe_removes_code():
    """on_unsubscribe(code)가 구독 목록에서 제거된다."""
    _, _, poller = _make_poller()
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")
    poller.on_unsubscribe("005930")
    assert "005930" not in poller._subscribed
    assert "000660" in poller._subscribed


async def test_set_excluded_codes():
    """set_excluded_codes로 WS-active 종목이 제외 집합에 설정된다."""
    _, _, poller = _make_poller()
    poller.set_excluded_codes({"005930", "000660"})
    assert "005930" in poller._excluded
    assert "000660" in poller._excluded


async def test_excluded_code_skipped_in_poll_cycle():
    """WS live_set에 있는 종목은 폴링에서 skip — fetch/publish 안 함.
    3콜 배제 의미를 유지하기 위해 capture_aux=True로 검증."""
    kis, buf, poller = _make_poller(capture_aux=True)
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")
    poller.set_excluded_codes({"005930"})  # 005930은 WS 수집 중 → skip

    await poller._poll_once()

    # 005930은 fetch 호출 없어야 함
    assert "005930" not in kis.calls["fetch_orderbook"]
    assert "005930" not in kis.calls["fetch_trades"]
    assert "005930" not in kis.calls["fetch_brokers"]
    # 000660은 fetch 됐어야 함
    assert "000660" in kis.calls["fetch_orderbook"]
    assert "000660" in kis.calls["fetch_trades"]
    assert "000660" in kis.calls["fetch_brokers"]


async def test_poll_cycle_default_orderbook_only_publishes_to_buffer():
    """기본(호가 전용, ADR-0098): 한 사이클에서 fetch_orderbook만 호출하고
    체결·거래원은 부르지 않으며 buffer.publish된다(저장 없음)."""
    kis, buf, poller = _make_poller()
    poller.on_subscribe("005930")

    await poller._poll_once()

    assert "005930" in kis.calls["fetch_orderbook"]
    # 호가 전용 — 체결·거래원은 폴링하지 않음.
    assert kis.calls["fetch_trades"] == []
    assert kis.calls["fetch_brokers"] == []

    result = await buf.get_latest("005930")
    assert result is not None
    assert result["code"] == "005930"


async def test_poll_default_publishes_ob_only_no_trade_broker():
    """기본은 buffer에 ob kind만 publish하고 trade/broker는 비어 있다."""
    _, buf, poller = _make_poller()
    poller.on_subscribe("005930")

    await poller._poll_once()

    series = await buf.get_series("005930")
    assert len(series["snapshots"]) >= 1     # ob
    assert len(series["trades"]) == 0        # 호가 전용
    assert len(series["brokers"]) == 0       # 호가 전용


async def test_poll_capture_aux_publishes_ob_trade_broker_kinds():
    """capture_aux=True면 기존처럼 ob/trade/broker 세 kind 모두 publish."""
    _, buf, poller = _make_poller(capture_aux=True)
    poller.on_subscribe("005930")

    await poller._poll_once()

    series = await buf.get_series("005930")
    assert len(series["snapshots"]) >= 1     # ob
    assert len(series["trades"]) >= 1        # trade
    assert len(series["brokers"]) >= 1       # broker


async def test_no_fetch_when_subscribed_set_empty():
    """구독 종목 없으면 fetch가 전혀 호출되지 않는다."""
    kis, buf, poller = _make_poller()
    # 아무것도 구독 안 함

    await poller._poll_once()

    assert kis.calls["fetch_orderbook"] == []
    assert kis.calls["fetch_trades"] == []
    assert kis.calls["fetch_brokers"] == []


async def test_poll_multiple_codes():
    """여러 종목이 구독되어 있으면 모두 폴링된다."""
    kis, buf, poller = _make_poller()
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")

    await poller._poll_once()

    assert "005930" in kis.calls["fetch_orderbook"]
    assert "000660" in kis.calls["fetch_orderbook"]


async def test_exception_isolation_per_code_does_not_kill_poller():
    """ADR-0064: 한 종목 fetch가 raise해도 다른 종목 처리가 계속된다.
    poller 태스크가 죽지 않고 alive = True를 유지한다."""
    kis, buf, poller = _make_poller(
        raise_for={"005930"},   # 005930 fetch → raise
        interval_s=0.02,
    )
    poller.on_subscribe("005930")   # 실패 종목
    poller.on_subscribe("000660")   # 성공 종목

    poller.start()
    try:
        # 몇 사이클 돌려서 살아있음을 확인
        for _ in range(50):
            await asyncio.sleep(0.01)
            if "000660" in kis.calls["fetch_orderbook"]:
                break

        # 살아있어야 함(ADR-0064: 거짓 health 금지)
        assert poller.alive is True

        # 005930는 fetch 시도했으나 실패, 000660는 성공해서 buffer에 들어감
        assert "000660" in kis.calls["fetch_orderbook"]
        result = await buf.get_latest("000660")
        assert result is not None

    finally:
        await poller.stop()


async def test_alive_false_after_stop():
    """stop() 후 alive == False (ADR-0064: 사망 감지 정직 노출)."""
    _, _, poller = _make_poller(interval_s=0.02)
    poller.on_subscribe("005930")
    poller.start()
    await asyncio.sleep(0.05)
    assert poller.alive is True

    await poller.stop()
    assert poller.alive is False


async def test_alive_derives_from_task_not_flag():
    """ADR-0064: alive는 task.done() 기반이어야 함 — 내부 플래그 아님.

    task가 외부에서 취소되어도 alive가 False를 정직하게 반환해야 한다.
    """
    _, _, poller = _make_poller(interval_s=0.02)
    poller.on_subscribe("005930")
    poller.start()
    await asyncio.sleep(0.02)
    assert poller.alive is True

    # 태스크를 직접 취소 (외부 교란 시뮬레이션)
    if poller._task is not None:
        poller._task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await poller._task

    # alive는 task 상태를 반영해야 함
    assert poller.alive is False


async def test_last_cycle_ms_updated_on_successful_cycle():
    """성공한 사이클 후 last_cycle_ms가 갱신된다 (stall 감지용)."""
    _, _, poller = _make_poller(interval_s=0.02)
    poller.on_subscribe("005930")

    assert poller.last_cycle_ms is None  # 시작 전

    await poller._poll_once()

    assert poller.last_cycle_ms is not None
    assert isinstance(poller.last_cycle_ms, int)


async def test_last_cycle_ms_not_updated_when_all_fail():
    """모든 코드가 실패해도 사이클 자체가 돌았으면 last_cycle_ms가 갱신된다."""
    _, _, poller = _make_poller(raise_for={"005930"}, interval_s=0.02)
    poller.on_subscribe("005930")

    # 실패하는 코드만 있어도 사이클은 완료됨 → last_cycle_ms 갱신
    await poller._poll_once()

    # 예외가 격리되므로 사이클은 완료 → cycle_ms 갱신됨
    assert poller.last_cycle_ms is not None


async def test_no_writer_calls_only_publish():
    """저장 경로(writer) 미사용 확인: buffer.publish만 호출.

    LiveRestPoller는 writer를 받지 않으므로 구조적으로 저장 불가.
    임시로 LiveWriter를 import해 monkeypatch로 append를 raise-on-call로 막고
    poller가 이를 건드리지 않음을 확인한다.
    """
    from hoga.live.writer import LiveWriter
    import unittest.mock as mock

    _, buf, poller = _make_poller()
    poller.on_subscribe("005930")

    # LiveWriter.append를 raise하도록 패치 (호출 시 테스트 실패)
    with mock.patch.object(LiveWriter, "append", side_effect=AssertionError("writer.append should not be called")):
        # 예외가 터지지 않으면 writer를 건드리지 않은 것
        await poller._poll_once()

    result = await buf.get_latest("005930")
    assert result is not None


async def test_start_stop_lifecycle():
    """start() → asyncio task 생성, stop() → task 취소 + 정리."""
    _, _, poller = _make_poller(interval_s=0.02)
    poller.on_subscribe("005930")

    assert poller._task is None
    poller.start()
    assert poller._task is not None
    assert not poller._task.done()

    await poller.stop()
    assert poller._task.done()


async def test_excluded_codes_updated_mid_run():
    """run 중에 set_excluded_codes를 호출하면 다음 사이클에 반영된다."""
    kis, buf, poller = _make_poller(interval_s=0.02)
    poller.on_subscribe("005930")
    poller.on_subscribe("000660")

    # 처음엔 모두 폴링
    await poller._poll_once()
    initial_count = len(kis.calls["fetch_orderbook"])
    assert "005930" in kis.calls["fetch_orderbook"]
    assert "000660" in kis.calls["fetch_orderbook"]

    # 005930을 excluded에 추가
    poller.set_excluded_codes({"005930"})

    # 다음 사이클: 005930 skip
    await poller._poll_once()
    # 000660은 한 번 더 호출됨
    assert kis.calls["fetch_orderbook"].count("000660") == 2
    # 005930은 추가 호출 없음
    assert kis.calls["fetch_orderbook"].count("005930") == 1


# ── 장 마감 게이트 (2026-06-09): phase=='closed'면 시세 불변 → 반복 폴링 skip,
# 구독 직후 1회 종가 스냅샷만. 재개장 시 정상 복원. ──


@pytest.mark.asyncio
async def test_poll_closed_one_snapshot_then_skips():
    """장 마감: 구독 종목을 1회만 스냅샷하고 이후 반복 폴링 skip(KIS 낭비 방지)."""
    kis, _buf, poller = _make_poller(phase_fn=lambda: "closed", capture_aux=True)
    poller.on_subscribe("005930")
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 1  # 1회 스냅샷
    await poller._poll_once()
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 1  # 반복 없음
    # trades/brokers도 동일하게 1회만(capture_aux=True 경로).
    assert kis.calls["fetch_trades"].count("005930") == 1
    assert kis.calls["fetch_brokers"].count("005930") == 1


@pytest.mark.asyncio
async def test_poll_closed_new_subscribe_gets_one_snapshot():
    """마감 중 새로 구독한 종목도 1회 스냅샷(기존 종목은 재폴링 안 함)."""
    kis, _buf, poller = _make_poller(phase_fn=lambda: "closed")
    poller.on_subscribe("005930")
    await poller._poll_once()
    poller.on_subscribe("000660")
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 1
    assert kis.calls["fetch_orderbook"].count("000660") == 1


@pytest.mark.asyncio
async def test_poll_closed_resubscribe_gets_fresh_snapshot():
    """마감 중 구독해제→재구독하면 새 스냅샷(1회 표식 제거)."""
    kis, _buf, poller = _make_poller(phase_fn=lambda: "closed")
    poller.on_subscribe("005930")
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 1
    poller.on_unsubscribe("005930")
    poller.on_subscribe("005930")
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 2  # 재구독 → 새 스냅샷


@pytest.mark.asyncio
async def test_poll_reopen_resumes_periodic_polling():
    """마감→재개장 전환 시 정상 주기 폴링 복원(1회 표식 clear)."""
    phase = {"v": "closed"}
    kis, _buf, poller = _make_poller(phase_fn=lambda: phase["v"])
    poller.on_subscribe("005930")
    await poller._poll_once()  # closed: 1회
    await poller._poll_once()  # closed: skip
    assert kis.calls["fetch_orderbook"].count("005930") == 1
    phase["v"] = "regular"
    await poller._poll_once()  # regular: 재개
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 3  # 1(closed) + 2(regular)


@pytest.mark.asyncio
async def test_poll_regular_polls_every_cycle_regression():
    """정규장: 매 사이클 폴링(게이트 도입 후 기존 동작 회귀가드)."""
    kis, _buf, poller = _make_poller(phase_fn=lambda: "regular")
    poller.on_subscribe("005930")
    await poller._poll_once()
    await poller._poll_once()
    assert kis.calls["fetch_orderbook"].count("005930") == 2


# ── Resolver freshness: no fixed KIS REST adapter cache ──────────────────────


@pytest.mark.asyncio
async def test_poll_resolves_background_client_each_cycle():
    """resolver를 매 사이클 호출해 scheduler proxy/fake 교체가 즉시 반영된다."""
    first = FakeKisClient()
    second = FakeKisClient()
    current = {"kis": first}
    buf = LiveBuffer()
    poller = LiveRestPoller(
        lambda: current["kis"], buf, interval_s=0.02, phase_fn=lambda: "regular"
    )
    poller.on_subscribe("005930")
    await poller._poll_once()
    assert first.calls["fetch_orderbook"] == ["005930"]
    assert second.calls["fetch_orderbook"] == []
    current["kis"] = second
    await poller._poll_once()
    assert first.calls["fetch_orderbook"] == ["005930"], "poller kept using stale adapter"
    assert second.calls["fetch_orderbook"] == ["005930"], "poller did not re-resolve adapter"


@pytest.mark.asyncio
async def test_poll_skips_cycle_when_resolver_returns_none():
    """resolver가 None 반환(creds 소실/완전 저하) → 그 사이클을 우아하게 skip(크래시
    없음), last_cycle_ms는 갱신(사이클 정상 완료 — stall 오탐 방지)."""
    buf = LiveBuffer()
    poller = LiveRestPoller(
        lambda: None, buf, interval_s=0.02, phase_fn=lambda: "regular"
    )
    poller.on_subscribe("005930")
    await poller._poll_once()  # raise 없이 통과
    assert poller.last_cycle_ms is not None  # 사이클 완료 신호 갱신
    assert await buf.get_latest("005930") is None  # 폴링 안 됨(publish 없음)


@pytest.mark.asyncio
async def test_transport_failure_logs_warning_without_traceback_and_sets_status(caplog):
    import httpx

    from hoga.live.kis_client import KisTransportError

    class TransportFailureKis(FakeKisClient):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls["fetch_orderbook"].append(code)
            raise KisTransportError(httpx.ConnectError("All connection attempts failed"))

    kis = TransportFailureKis()
    buf = LiveBuffer()
    poller = LiveRestPoller(lambda: kis, buf, interval_s=0.02, phase_fn=lambda: "regular")
    poller.on_subscribe("247540")

    with caplog.at_level("WARNING", logger="hoga.live.rest_poller"):
        await poller._poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest_poller"]
    assert len(records) == 1
    assert records[0].exc_info is None
    assert records[0].getMessage() == (
        "live.rest_poller.code_failed code=247540 "
        "kind=transport error=TRANSPORT/ConnectError"
    )
    status = poller.status()
    assert status.last_error_count == 1
    assert status.last_error_kind == "transport"
    assert status.last_error_code == "TRANSPORT/ConnectError"
    assert status.degraded is True
    assert status.backoff_remaining == 3


@pytest.mark.asyncio
async def test_transport_backoff_skips_next_cycle_without_refetching():
    import httpx

    from hoga.live.kis_client import KisTransportError

    class TransportFailureKis(FakeKisClient):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls["fetch_orderbook"].append(code)
            raise KisTransportError(httpx.ConnectError("down"))

    kis = TransportFailureKis()
    poller = LiveRestPoller(
        lambda: kis,
        LiveBuffer(),
        interval_s=0.02,
        phase_fn=lambda: "regular",
    )
    poller.on_subscribe("005930")

    await poller._poll_once()
    await poller._poll_once()

    assert kis.calls["fetch_orderbook"] == ["005930"]
    assert poller.status().backoff_remaining == 2
    assert poller.last_cycle_ms is not None


@pytest.mark.asyncio
async def test_unexpected_failure_logs_with_traceback_and_no_backoff(caplog):
    _, _, poller = _make_poller(raise_for={"005930"}, interval_s=0.02)
    poller.on_subscribe("005930")

    with caplog.at_level("ERROR", logger="hoga.live.rest_poller"):
        await poller._poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest_poller"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest_poller.code_failed code=005930 kind=unexpected error=RuntimeError"
    )
    status = poller.status()
    assert status.last_error_kind == "unexpected"
    assert status.last_error_code == "RuntimeError"
    assert status.backoff_remaining == 0


@pytest.mark.asyncio
async def test_cycle_failure_sets_internal_status_and_keeps_loop_alive(caplog):
    def broken_phase() -> str:
        raise RuntimeError("phase failed")

    _, _, poller = _make_poller(interval_s=60.0, phase_fn=broken_phase)
    poller.on_subscribe("005930")

    with caplog.at_level("ERROR", logger="hoga.live.rest_poller"):
        poller.start()
        try:
            for _ in range(50):
                await asyncio.sleep(0.01)
                if poller.status().last_error_kind == "internal":
                    break

            assert poller.alive is True
            status = poller.status()
            assert status.degraded is True
            assert status.last_error == "RuntimeError: phase failed"
            assert status.last_error_kind == "internal"
            assert status.last_error_code == "RuntimeError"
            assert status.last_error_count == 1
            assert status.backoff_remaining == 0
        finally:
            await poller.stop()

    records = [r for r in caplog.records if r.name == "hoga.live.rest_poller"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest_poller.cycle_failed kind=internal error=RuntimeError"
    )


@pytest.mark.asyncio
async def test_successful_cycle_clears_degraded_status_after_failure():
    class FirstBrokenThenHealthy(FakeKisClient):
        def __init__(self) -> None:
            super().__init__()
            self.fail = True

        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            if self.fail:
                self.calls["fetch_orderbook"].append(code)
                raise RuntimeError("boom")
            return await super().fetch_orderbook(code)

    kis = FirstBrokenThenHealthy()
    poller = LiveRestPoller(lambda: kis, LiveBuffer(), interval_s=0.02, phase_fn=lambda: "regular")
    poller.on_subscribe("005930")

    await poller._poll_once()
    assert poller.status().degraded is True

    kis.fail = False
    await poller._poll_once()

    status = poller.status()
    assert status.degraded is False
    assert status.last_error is None
    assert status.last_error_kind is None
    assert status.last_error_code is None
    assert status.last_error_count == 0


def test_live_rest_poller_still_has_no_writer_dependency() -> None:
    import inspect

    import hoga.live.rest_poller as rest_poller

    src = inspect.getsource(rest_poller.LiveRestPoller)
    assert "LiveWriter" not in src
    assert "promote_api_today" not in src
    assert "live_api" not in src
