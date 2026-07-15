"""BrokerRestPoller — 거래원 REST 폴러(ADR-0111) 단위 테스트.

패턴은 test_rest30_recorder.py를 미러(FakeKis, 고정 clock, gated-fetch 동시성 실증,
코드별 격리). 폴러 자체 테스트는 WS TR 개수(2 vs 3)에 의존하지 않게 작성해 PR②(TR 제거)
후에도 그대로 통과한다.

파일 하단의 parity 테스트가 이 PR의 핵심 안전망: WS member 프레임 경로와 폴러 경로가
byte-identical한 저장 JSONL을 만든다는 것을 실증한다 → promote → brokers.parquet →
거래원등장 마커가 두 경로를 구분할 수 없음을 보장(소비자 무변경 계약).
"""
from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from hoga.live.kis_models import KisBrokerEntry, KisBrokers
from hoga.live.snapshot import SnapshotKind
from hoga.live.ws_frames import WsTick

if TYPE_CHECKING:
    from hoga.live.broker_rest_poller import KisBrokerFetchProto

_FIXED_NOW = 1770000000000


class FakeBrokerKis:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def fetch_brokers(self, code: str) -> KisBrokers:
        self.calls.append(code)
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="미래", qty=7)],
            sell_top=[KisBrokerEntry(name="삼성", qty=5)],
        )


class _Collector:
    """dispatch_fn 대체 — 디스패치된 WsTick을 수집한다."""

    def __init__(self) -> None:
        self.ticks: list[WsTick] = []

    async def __call__(self, tick: WsTick) -> None:
        self.ticks.append(tick)


def _make_poller(
    *,
    kis: "KisBrokerFetchProto",
    dispatch: _Collector,
    trading_day: bool = True,
    venue: str = "KRX",
    **kwargs: object,
):
    from hoga.live.broker_rest_poller import BrokerRestPoller

    return BrokerRestPoller(
        kis_resolver=lambda: kis,
        dispatch_fn=dispatch,
        now_ms_fn=lambda: _FIXED_NOW,
        trading_day_fn=lambda: trading_day,
        venue_fn=lambda: venue,
        **kwargs,  # type: ignore[arg-type]
    )


@pytest.mark.asyncio
async def test_poll_once_dispatches_one_broker_tick_per_target() -> None:
    kis = FakeBrokerKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch)
    poller.set_targets({"005930", "000660"})

    await poller.poll_once()

    assert sorted(kis.calls) == ["000660", "005930"]
    assert len(dispatch.ticks) == 2
    tick = next(t for t in dispatch.ticks if t.code == "005930")
    assert tick.kind is SnapshotKind.BROKER
    assert tick.venue == "KRX"
    # payload 키가 정확히 _parse_member와 일치(phase 없음) — byte-parity 계약.
    assert set(tick.payload.keys()) == {"code", "t_ms", "sell_top", "buy_top"}
    assert "phase" not in tick.payload
    assert tick.payload["t_ms"] == _FIXED_NOW
    assert tick.payload["sell_top"] == [{"name": "삼성", "qty": 5}]
    assert tick.payload["buy_top"] == [{"name": "미래", "qty": 7}]
    status = poller.status()
    assert status.target_count == 2
    assert status.last_error_count == 0
    assert status.degraded is False


@pytest.mark.asyncio
async def test_poll_once_isolates_one_code_failure() -> None:
    class PartlyBroken(FakeBrokerKis):
        async def fetch_brokers(self, code: str) -> KisBrokers:
            if code == "000660":
                raise RuntimeError("boom")
            return await super().fetch_brokers(code)

    kis = PartlyBroken()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch)
    poller.set_targets({"005930", "000660"})

    await poller.poll_once()

    # 한 종목 실패가 다른 종목 디스패치를 막지 않는다(격리 불변식).
    assert [t.code for t in dispatch.ticks] == ["005930"]
    status = poller.status()
    assert status.last_error_count == 1
    assert status.degraded is True


@pytest.mark.asyncio
async def test_poll_once_skips_on_non_trading_day() -> None:
    kis = FakeBrokerKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch, trading_day=False)
    poller.set_targets({"005930"})

    await poller.poll_once()

    assert kis.calls == []
    assert dispatch.ticks == []
    assert poller.status().degraded is False


@pytest.mark.asyncio
async def test_poll_once_skips_outside_krx_venue_window() -> None:
    """거래원 TR은 KRX 전용 — venue_fn이 NXT면(08:50 이전·15:31 이후) 폴링 안 함."""
    kis = FakeBrokerKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch, venue="NXT")
    poller.set_targets({"005930"})

    await poller.poll_once()

    assert kis.calls == []
    assert dispatch.ticks == []


@pytest.mark.asyncio
async def test_poll_once_empty_targets_is_noop() -> None:
    kis = FakeBrokerKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch)
    # set_targets 호출 안 함 → 빈 타깃

    await poller.poll_once()

    assert kis.calls == []
    assert dispatch.ticks == []
    assert poller.status().last_error_count == 0


@pytest.mark.asyncio
async def test_set_targets_shrink_drops_codes() -> None:
    kis = FakeBrokerKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch)
    poller.set_targets({"005930", "000660"})
    poller.set_targets({"005930"})  # 축소

    await poller.poll_once()

    assert kis.calls == ["005930"]
    assert poller.status().target_count == 1


@pytest.mark.asyncio
async def test_rate_limit_error_does_not_supervisor_backoff() -> None:
    """EGW00201은 토큰버킷이 retry로 흡수하므로(ADR-0100) 폴러 레벨 backoff를 걸지 않는다
    — rest30_recorder와 동일 정책. 에러는 status에 노출하되 다음 사이클은 계속 폴링한다."""
    from hoga.live.kis_client import KisRateLimitError

    class RateLimited(FakeBrokerKis):
        async def fetch_brokers(self, code: str) -> KisBrokers:
            self.calls.append(code)
            raise KisRateLimitError("rate limited")

    kis = RateLimited()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch, backoff_cycles=1)
    poller.set_targets({"005930"})

    await poller.poll_once()
    await poller.poll_once()

    # backoff가 안 걸리므로 두 사이클 모두 폴링(EGW00201은 버킷이 처리).
    assert kis.calls == ["005930", "005930"]
    status = poller.status()
    assert status.last_error_kind == "rate_limit"
    assert status.last_error_code == "EGW00201"
    assert status.degraded is True
    assert status.backoff_remaining == 0


@pytest.mark.asyncio
async def test_kis_unavailable_is_marked_but_not_fatal() -> None:
    dispatch = _Collector()
    from hoga.live.broker_rest_poller import BrokerRestPoller

    poller = BrokerRestPoller(
        kis_resolver=lambda: None,  # creds 소실 등
        dispatch_fn=dispatch,
        now_ms_fn=lambda: _FIXED_NOW,
        trading_day_fn=lambda: True,
        venue_fn=lambda: "KRX",
    )
    poller.set_targets({"005930"})

    await poller.poll_once()

    assert dispatch.ticks == []
    status = poller.status()
    assert status.last_error_code == "kis_unavailable"


@pytest.mark.asyncio
async def test_dispatches_codes_concurrently() -> None:
    """코드 간 동시 fetch — gated fake로 진짜 동시성 실증(순차여도 통과 금지)."""
    class GatedKis(FakeBrokerKis):
        def __init__(self) -> None:
            super().__init__()
            self.inflight = 0
            self.max_inflight = 0
            self.release = asyncio.Event()

        async def fetch_brokers(self, code: str) -> KisBrokers:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                await self.release.wait()
            finally:
                self.inflight -= 1
            return await super().fetch_brokers(code)

    kis = GatedKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch, concurrency=4)
    poller.set_targets({"005930", "000660", "035420"})

    task = asyncio.create_task(poller.poll_once())
    for _ in range(50):
        await asyncio.sleep(0)
        if kis.max_inflight >= 2:
            break
    assert kis.max_inflight >= 2, "동시 디스패치가 안 됨(직렬)"
    kis.release.set()
    await task


@pytest.mark.asyncio
async def test_concurrency_cap_bounds_inflight() -> None:
    """concurrency=2면 동시 in-flight ≤ 2."""
    class CountingKis(FakeBrokerKis):
        def __init__(self) -> None:
            super().__init__()
            self.inflight = 0
            self.max_inflight = 0

        async def fetch_brokers(self, code: str) -> KisBrokers:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            await asyncio.sleep(0)  # 양보 → 상한 없으면 다 겹침
            self.inflight -= 1
            return await super().fetch_brokers(code)

    kis = CountingKis()
    dispatch = _Collector()
    poller = _make_poller(kis=kis, dispatch=dispatch, concurrency=2)
    poller.set_targets({"005930", "000660", "035420", "051910", "005380"})

    await poller.poll_once()

    assert kis.max_inflight <= 2


@pytest.mark.asyncio
async def test_bounce_delta_surfaced_in_status() -> None:
    """직전 사이클 EGW00201 바운스 델타가 status에 노출된다(rate_limit_bounces)."""
    kis = FakeBrokerKis()
    dispatch = _Collector()
    # 사이클 경계에서 bounce_counter_fn이 두 번(gather 전/후) 호출된다 — 그 사이 프로세스
    # 전역 바운스가 0→3 증가한 상황을 시뮬레이션(before=0, after=3 → 델타 3).
    counter = iter([0, 3])
    from hoga.live.broker_rest_poller import BrokerRestPoller

    poller = BrokerRestPoller(
        kis_resolver=lambda: kis,
        dispatch_fn=dispatch,
        now_ms_fn=lambda: _FIXED_NOW,
        trading_day_fn=lambda: True,
        venue_fn=lambda: "KRX",
        bounce_counter_fn=lambda: next(counter, 3),
    )
    poller.set_targets({"005930", "000660"})

    await poller.poll_once()

    assert poller.status().rate_limit_bounces == 3


# ── Parity: WS member 경로 vs 폴러 경로 저장 JSONL byte-identity ─────────────────

def _mbc_frame_matching_brokers() -> tuple[str, KisBrokers]:
    """동일 거래원 데이터를 표현하는 (WS H0STMBC0 프레임, KisBrokers) 쌍을 만든다.
    _parse_member는 sell/buy 각 5개를 요구하므로 5개씩 채운다."""
    f = ["0"] * 80
    f[0] = "005930"
    sell = [("삼성", 5), ("미래", 4), ("키움", 3), ("NH", 2), ("한투", 1)]
    buy = [("KB", 9), ("신한", 8), ("하나", 7), ("메리츠", 6), ("대신", 5)]
    for i, (name, _) in enumerate(sell):
        f[1 + i] = name
    for i, (name, _) in enumerate(buy):
        f[6 + i] = name
    for i, (_, qty) in enumerate(sell):
        f[11 + i] = str(qty)
    for i, (_, qty) in enumerate(buy):
        f[16 + i] = str(qty)
    frame = "0|H0STMBC0|001|" + "^".join(f)
    brokers = KisBrokers(
        code="005930",
        sell_top=[KisBrokerEntry(name=n, qty=q) for n, q in sell],
        buy_top=[KisBrokerEntry(name=n, qty=q) for n, q in buy],
    )
    return frame, brokers


def test_broker_ws_tick_payload_parity_with_ws_member_frame() -> None:
    """brokers_to_ws_tick가 _parse_member와 동일 payload를 만든다(같은 now_ms 기준)."""
    from hoga.live.broker_rest_poller import brokers_to_ws_tick
    from hoga.live.ws_frames import parse_message

    frame, brokers = _mbc_frame_matching_brokers()
    ws_tick = parse_message(frame, date="20260605", now_ms=_FIXED_NOW)[0]
    poll_tick = brokers_to_ws_tick(brokers, now_ms=_FIXED_NOW)

    assert poll_tick.kind is ws_tick.kind
    assert poll_tick.venue == ws_tick.venue
    assert poll_tick.t_ms == ws_tick.t_ms
    # 키 순서까지 동일해야 JSONL이 byte-identical(dict 삽입순 보존).
    assert list(poll_tick.payload.keys()) == list(ws_tick.payload.keys())
    assert poll_tick.payload == ws_tick.payload


@pytest.mark.asyncio
async def test_broker_poller_jsonl_identical_to_ws_member_path(tmp_path) -> None:
    """스트림 특성화: 두 경로가 같은 거래원 값을 저장하면 JSONL broker 라인이 byte-identical.
    이게 promote → brokers.parquet → 거래원등장 마커의 소비자 무변경 계약의 실증이다."""
    from hoga.live.broker_rest_poller import brokers_to_ws_tick
    from hoga.live.buffer import LiveBuffer
    from hoga.live.stream import LiveStream
    from hoga.live.writer import LiveWriter
    from hoga.live.ws_frames import parse_message

    frame, brokers = _mbc_frame_matching_brokers()
    flush_ms = _FIXED_NOW + 10_000

    async def _run(tick: WsTick, sub: str) -> str:
        stream = LiveStream(
            buffer=LiveBuffer(),
            writer=LiveWriter(tmp_path / sub),
            date_fn=lambda: "20260605",
            phase_fn=lambda: "regular",
        )
        stream.set_active_codes({"005930"})
        stream._gate_open = True  # 정규장 저장 게이트 열림(단위 테스트라 직접 설정)
        await stream.on_tick(tick)
        await stream.flush_once(now_ms=flush_ms)
        text = (tmp_path / sub / "20260605" / "005930.jsonl").read_text()
        return next(ln for ln in text.splitlines() if '"kind": "broker"' in ln)

    ws_line = await _run(
        parse_message(frame, date="20260605", now_ms=_FIXED_NOW)[0], "ws"
    )
    poll_line = await _run(brokers_to_ws_tick(brokers, now_ms=_FIXED_NOW), "poll")

    assert ws_line == poll_line
