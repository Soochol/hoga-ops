from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from hoga.live.kis_models import (
    KisBrokerEntry,
    KisBrokers,
    KisOrderbook,
    KisTrade,
    OrderbookLevel,
)


class FakeKis:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []
        self.trade_price = 100

    async def fetch_orderbook(self, code: str) -> KisOrderbook:
        self.calls.append(("orderbook", code))
        return KisOrderbook(
            code=code,
            asks=[OrderbookLevel(price=101, qty=10)],
            bids=[OrderbookLevel(price=100, qty=20)],
            total_ask_qty=10,
            total_bid_qty=20,
            t_ms=1770000000000,
        )

    async def fetch_trades(self, code: str) -> list[KisTrade]:
        self.calls.append(("trades", code))
        return [
            KisTrade(
                price=self.trade_price,
                qty=3,
                side=1,
                side_source="inferred",
                t_ms=1770000000000,
            )
        ]

    async def fetch_brokers(self, code: str) -> KisBrokers:
        self.calls.append(("brokers", code))
        return KisBrokers(
            code=code,
            buy_top=[KisBrokerEntry(name="미래", qty=7)],
            sell_top=[KisBrokerEntry(name="삼성", qty=5)],
        )


@pytest.mark.asyncio
async def test_rest30_recorder_poll_once_writes_three_payload_kinds(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        interval_s=30.0,
        capture_aux=True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()

    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 3
    assert '"kind": "ob"' in lines[0]
    assert '"kind": "trade"' in lines[1]
    assert '"kind": "broker"' in lines[2]
    assert kis.calls == [
        ("orderbook", "005930"),
        ("trades", "005930"),
        ("brokers", "005930"),
    ]
    status = recorder.status()
    assert status.target_count == 1
    assert status.last_error_count == 0
    assert status.degraded is False


@pytest.mark.asyncio
async def test_rest30_recorder_isolates_one_symbol_failure(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class PartlyBroken(FakeKis):
        async def fetch_orderbook(self, code: str):
            if code == "000660":
                raise RuntimeError("boom")
            return await super().fetch_orderbook(code)

    recorder = Rest30sRecorder(
        kis_resolver=lambda: PartlyBroken(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930", "000660"})

    await recorder.poll_once()

    assert (tmp_path / "live_api" / "20260622" / "005930.jsonl").exists()
    assert not (tmp_path / "live_api" / "20260622" / "000660.jsonl").exists()
    assert recorder.status().last_error_count == 1
    assert recorder.status().degraded is True


@pytest.mark.asyncio
async def test_rest30_recorder_logs_transport_failures_without_traceback(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.kis_client import KisTransportError
    from hoga.live.rest30_recorder import Rest30sRecorder

    class TimeoutKis(FakeKis):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls.append(("orderbook", code))
            raise KisTransportError(httpx.ConnectTimeout("connect timed out"))

    kis = TimeoutKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930"})

    with caplog.at_level("WARNING", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest30_recorder"]
    assert len(records) == 1
    assert records[0].levelname == "WARNING"
    assert records[0].exc_info is None
    assert records[0].getMessage() == (
        "live.rest30.api_code_failed code=005930 "
        "kind=transport error=TRANSPORT/ConnectTimeout"
    )
    status = recorder.status()
    assert status.last_error_count == 1
    assert status.last_error == (
        "KisTransportError: KIS api error TRANSPORT/ConnectTimeout: connect timed out"
    )
    assert status.last_error_kind == "transport"
    assert status.last_error_code == "TRANSPORT/ConnectTimeout"
    assert status.backoff_remaining == 3


@pytest.mark.asyncio
async def test_rest30_recorder_does_not_cap_targets(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    targets = {f"{i:06d}" for i in range(50)}

    recorder.set_targets(targets)

    assert recorder.status().target_count == 50
    assert set(recorder.status().targets) == targets


@pytest.mark.asyncio
async def test_rest30_recorder_closed_market_fetches_one_snapshot_per_target(
    tmp_path: Path,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "closed",
        capture_aux=True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()

    assert kis.calls == [
        ("orderbook", "005930"),
        ("trades", "005930"),
        ("brokers", "005930"),
    ]
    assert len((tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()) == 3


@pytest.mark.asyncio
async def test_rest30_recorder_skips_capture_on_non_trading_day(tmp_path: Path) -> None:
    """비거래일(주말/휴장)엔 phase가 시계상 'regular'여도 저장 금지 (ADR-0099 파리티).

    회귀: market_phase(시계만)는 토요일 09:00–15:30에도 'regular'라 closed 게이트를
    통과시켜 유령 캡처를 만들었다. trading_day_fn=False면 fetch/write가 0이어야 한다.
    """
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260711",  # 토요일
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",  # 시계상 정규장 — 게이트를 통과시키던 지점
        trading_day_fn=lambda: False,  # 캘린더: 비거래일
        capture_aux=True,
    )
    recorder.set_targets({"005930", "000660"})

    await recorder.poll_once()
    await recorder.poll_once()

    assert kis.calls == []  # 어떤 fetch도 없어야 함
    assert not (tmp_path / "live_api" / "20260711").exists()  # 디스크 저장 0
    status = recorder.status()
    assert status.last_error_count == 0
    assert status.degraded is False


@pytest.mark.asyncio
async def test_rest30_recorder_non_trading_day_skips_even_closed_snapshot(
    tmp_path: Path,
) -> None:
    """비거래일엔 장마감(closed) 1회-스냅샷 경로도 열리면 안 된다 — 유령 마감 호가 방지.

    거래일 closed는 종가 호가를 1회 캡처하지만, 비거래일엔 의미 있는 마감 호가가 없다.
    """
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260711",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "closed",
        trading_day_fn=lambda: False,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()

    assert kis.calls == []
    assert not (tmp_path / "live_api" / "20260711").exists()


@pytest.mark.asyncio
async def test_rest30_recorder_captures_on_trading_day(tmp_path: Path) -> None:
    """양성 대조: 거래일(trading_day_fn=True) + regular면 기존대로 캡처한다."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260710",  # 금요일(거래일)
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        trading_day_fn=lambda: True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()

    assert ("orderbook", "005930") in kis.calls
    assert (tmp_path / "live_api" / "20260710" / "005930.jsonl").exists()


@pytest.mark.asyncio
async def test_rest30_recorder_dedupes_repeated_trade_batches(tmp_path: Path) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        capture_aux=True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()
    kis.trade_price = 101
    await recorder.poll_once()

    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    trade_lines = [line for line in lines if '"kind": "trade"' in line]
    assert len(trade_lines) == 2


@pytest.mark.asyncio
async def test_rest30_recorder_keeps_duplicate_trades_within_same_batch(
    tmp_path: Path,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class DuplicateBatch(FakeKis):
        async def fetch_trades(self, code: str) -> list[KisTrade]:
            self.calls.append(("trades", code))
            trade = KisTrade(
                price=100,
                qty=3,
                side=1,
                side_source="inferred",
                t_ms=1770000000000,
            )
            return [trade, trade]

    kis = DuplicateBatch()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        capture_aux=True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()

    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    trade_lines = [line for line in lines if '"kind": "trade"' in line]
    assert len(trade_lines) == 2


@pytest.mark.asyncio
async def test_rest30_recorder_repeated_batch_does_not_inflate_seen_count(
    tmp_path: Path,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class GrowingBatch(FakeKis):
        def __init__(self) -> None:
            super().__init__()
            self.batch_sizes = [2, 2, 3]

        async def fetch_trades(self, code: str) -> list[KisTrade]:
            self.calls.append(("trades", code))
            n = self.batch_sizes.pop(0)
            trade = KisTrade(
                price=100,
                qty=3,
                side=1,
                side_source="inferred",
                t_ms=1770000000000,
            )
            return [trade] * n

    kis = GrowingBatch()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        capture_aux=True,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()
    await recorder.poll_once()

    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    trade_lines = [line for line in lines if '"kind": "trade"' in line]
    assert len(trade_lines) == 3


@pytest.mark.asyncio
async def test_rest30_recorder_rate_limit_does_not_supervisor_backoff(
    tmp_path: Path,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.kis_client import KisRateLimitError
    from hoga.live.rest30_recorder import Rest30sRecorder

    class RateLimited(FakeKis):
        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.calls.append(("orderbook", code))
            raise KisRateLimitError("rate limited")

    kis = RateLimited()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        backoff_cycles=1,
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()
    await recorder.poll_once()

    assert kis.calls == [("orderbook", "005930"), ("orderbook", "005930")]
    status = recorder.status()
    assert status.degraded is True
    assert status.last_error_kind == "rate_limit"
    assert status.last_error_code == "EGW00201"
    assert status.backoff_remaining == 0


@pytest.mark.asyncio
async def test_rest30_recorder_unexpected_failures_keep_traceback(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class Broken(FakeKis):
        async def fetch_orderbook(self, code: str):
            raise RuntimeError("boom")

    recorder = Rest30sRecorder(
        kis_resolver=lambda: Broken(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930"})

    with caplog.at_level("ERROR", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()

    records = [r for r in caplog.records if r.name == "hoga.live.rest30_recorder"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest30.code_failed code=005930 kind=unexpected error=RuntimeError"
    )
    assert recorder.status().last_error_kind == "unexpected"
    assert recorder.status().last_error_code == "RuntimeError"


@pytest.mark.asyncio
async def test_rest30_recorder_cycle_failure_sets_internal_kind_code(
    tmp_path: Path,
    caplog: pytest.LogCaptureFixture,
) -> None:
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    async def fail_fsync() -> None:
        raise RuntimeError("fsync failed")

    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        interval_s=60.0,
    )
    recorder.set_targets({"005930"})
    recorder._writer.fsync_all = fail_fsync

    with caplog.at_level("ERROR", logger="hoga.live.rest30_recorder"):
        recorder.start()
        try:
            for _ in range(50):
                await asyncio.sleep(0.01)
                if recorder.status().last_error_kind == "internal":
                    break

            status = recorder.status()
            assert status.running is True
            assert status.degraded is True
            assert status.last_error == "RuntimeError: fsync failed"
            assert status.last_error_kind == "internal"
            assert status.last_error_code == "RuntimeError"
            assert status.last_error_count == 1
            assert status.backoff_remaining == 0
        finally:
            await recorder.stop()

    records = [r for r in caplog.records if r.name == "hoga.live.rest30_recorder"]
    assert len(records) == 1
    assert records[0].exc_info is not None
    assert records[0].getMessage() == (
        "live.rest30.cycle_failed kind=internal error=RuntimeError"
    )


# ── ADR-0098: 호가 전용 기본 + 동시 디스패치 + 경계 스케줄링 ──


@pytest.mark.asyncio
async def test_rest30_recorder_default_captures_orderbook_only(tmp_path: Path) -> None:
    """기본(capture_aux=False)은 10호가만 fetch/저장 — 체결·거래원 콜 없음."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    kis = FakeKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930"})

    await recorder.poll_once()

    assert kis.calls == [("orderbook", "005930")]  # 호가 1콜만
    lines = (tmp_path / "live_api" / "20260622" / "005930.jsonl").read_text().splitlines()
    assert len(lines) == 1
    assert '"kind": "ob"' in lines[0]
    assert '"kind": "trade"' not in "".join(lines)
    assert '"kind": "broker"' not in "".join(lines)


@pytest.mark.asyncio
async def test_rest30_recorder_dispatches_codes_concurrently(tmp_path: Path) -> None:
    """코드 간 동시 디스패치 — 여러 종목의 fetch가 겹쳐서 in-flight ≥ 2가 된다.
    gated fake로 진짜 동시성을 실증(PR #530 교훈: 순차여도 통과하는 테스트 금지)."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class GatedKis(FakeKis):
        def __init__(self) -> None:
            super().__init__()
            self.inflight = 0
            self.max_inflight = 0
            self.release = asyncio.Event()

        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            try:
                await self.release.wait()
            finally:
                self.inflight -= 1
            return await super().fetch_orderbook(code)

    kis = GatedKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        concurrency=4,
    )
    recorder.set_targets({"005930", "000660", "035420"})

    task = asyncio.create_task(recorder.poll_once())
    # 게이트를 잡고 있는 동안 여러 종목이 동시에 fetch에 진입해야 한다.
    for _ in range(50):
        await asyncio.sleep(0)
        if kis.max_inflight >= 2:
            break
    assert kis.max_inflight >= 2, "동시 디스패치가 안 됨(직렬)"
    kis.release.set()
    await task


@pytest.mark.asyncio
async def test_rest30_recorder_concurrency_cap_bounds_inflight(tmp_path: Path) -> None:
    """동시성 상한이 in-flight를 제한한다 — concurrency=2면 max_inflight ≤ 2."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    class CountingKis(FakeKis):
        def __init__(self) -> None:
            super().__init__()
            self.inflight = 0
            self.max_inflight = 0

        async def fetch_orderbook(self, code: str) -> KisOrderbook:
            self.inflight += 1
            self.max_inflight = max(self.max_inflight, self.inflight)
            await asyncio.sleep(0)  # 다른 태스크에 양보 → 상한 없으면 다 겹침
            self.inflight -= 1
            return await super().fetch_orderbook(code)

    kis = CountingKis()
    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        concurrency=2,
    )
    recorder.set_targets({f"{i:06d}" for i in range(10)})

    await recorder.poll_once()

    assert kis.max_inflight <= 2
    assert recorder.status().last_cycle_duration_ms is not None


@pytest.mark.asyncio
async def test_rest30_recorder_no_targets_refreshes_cycle_duration(
    tmp_path: Path,
) -> None:
    """대상이 없는 사이클도 last_cycle_duration_ms를 갱신한다 — 직전 느린 fetch
    사이클의 값이 stale로 남지 않는다(ADR-0098 관측 지표)."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder._last_cycle_duration_ms = 18_000  # 직전 느린 사이클 잔재

    await recorder.poll_once()  # 대상 없음 → 조기 return

    assert recorder.status().last_cycle_duration_ms == 0  # stale 18s가 덮임


@pytest.mark.asyncio
async def test_rest30_recorder_backoff_cycle_refreshes_cycle_duration(
    tmp_path: Path,
) -> None:
    """backoff 소진 사이클도 duration을 갱신한다(조기 return 경로 커버)."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
    )
    recorder.set_targets({"005930"})
    recorder._backoff_remaining = 2
    recorder._last_cycle_duration_ms = 18_000

    await recorder.poll_once()  # backoff 1 소진 → 조기 return

    assert recorder._backoff_remaining == 1
    assert recorder.status().last_cycle_duration_ms == 0


def test_rest30_recorder_next_delay_aligns_to_wall_clock_boundary(tmp_path: Path) -> None:
    """_next_delay_s는 다음 벽시계 interval 경계까지의 잔여를 준다(위상 정렬)."""
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    now = {"ms": 1770000010500}  # 10.5초 경과(30초 주기 기준)
    recorder = Rest30sRecorder(
        kis_resolver=lambda: FakeKis(),
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: now["ms"],
        phase_fn=lambda: "regular",
        interval_s=30.0,
    )
    # 1770000010.5 % 30 = 10.5 → 다음 경계까지 19.5초.
    assert recorder._next_delay_s() == pytest.approx(19.5)
    now["ms"] = 1770000030000  # 정각 경계 → 0이 아니라 한 주기(0 sleep 재진입 방지).
    assert recorder._next_delay_s() == pytest.approx(30.0)


# ------------------------------------------------------------------------
# EGW00201 바운스 사이클 집계 (2026-07-13, 제안 A)
# 프로세스 전역 바운스 카운터 델타를 사이클 단위 관측/경보로 접는다.
# ------------------------------------------------------------------------


class _BouncingKis(FakeKis):
    """fetch마다 공유 바운스 카운터를 증가시켜, 사이클 중 카운터가 오르는 실제
    흐름을 재현한다(레코더의 before/after 델타 샘플링을 정직하게 검증)."""

    def __init__(self, counter: dict[str, int], bumps_per_fetch: int) -> None:
        super().__init__()
        self._counter = counter
        self._bumps = bumps_per_fetch

    async def fetch_orderbook(self, code: str):
        self._counter["v"] += self._bumps
        return await super().fetch_orderbook(code)


def _make_recorder(tmp_path: Path, counter: dict[str, int], kis, targets: set[str]):
    from hoga.live.buffer import LiveBuffer
    from hoga.live.rest30_recorder import Rest30sRecorder

    recorder = Rest30sRecorder(
        kis_resolver=lambda: kis,
        buffer=LiveBuffer(),
        data_dir=tmp_path,
        date_fn=lambda: "20260622",
        now_ms_fn=lambda: 1770000000000,
        phase_fn=lambda: "regular",
        trading_day_fn=lambda: True,
        interval_s=10.0,
        bounce_counter_fn=lambda: counter["v"],
    )
    recorder.set_targets(targets)
    return recorder


@pytest.mark.asyncio
async def test_rest30_records_cycle_bounce_delta_in_status(tmp_path: Path) -> None:
    """사이클 중 오른 바운스 델타가 status.rate_limit_bounces에 반영된다."""
    counter = {"v": 0}
    kis = _BouncingKis(counter, bumps_per_fetch=2)  # 종목당 2 바운스
    recorder = _make_recorder(tmp_path, counter, kis, {"005930", "000660"})

    await recorder.poll_once()

    assert recorder.status().rate_limit_bounces == 4  # 2종목 × 2


@pytest.mark.asyncio
async def test_rest30_zero_bounce_cycle_logs_no_info(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """무바운스 사이클은 INFO cycle_done을 내지 않는다(정상 시간대 로그 침묵)."""
    counter = {"v": 0}
    kis = _BouncingKis(counter, bumps_per_fetch=0)
    recorder = _make_recorder(tmp_path, counter, kis, {"005930"})

    with caplog.at_level("INFO", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()

    cycle_logs = [r for r in caplog.records if "cycle_done" in r.getMessage()]
    assert cycle_logs == []  # INFO 레벨에선 아무것도 안 보임
    assert recorder.status().rate_limit_bounces == 0


@pytest.mark.asyncio
async def test_rest30_bounce_cycle_logs_info_summary(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """바운스>0 사이클은 요약 1줄 INFO를 낸다(개별 이벤트 대신 율)."""
    counter = {"v": 0}
    kis = _BouncingKis(counter, bumps_per_fetch=1)
    recorder = _make_recorder(tmp_path, counter, kis, {"005930"})

    with caplog.at_level("INFO", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()

    cycle_logs = [r for r in caplog.records if "cycle_done" in r.getMessage()]
    assert len(cycle_logs) == 1
    assert "bounces=1" in cycle_logs[0].getMessage()


@pytest.mark.asyncio
async def test_rest30_anomaly_warns_after_consecutive_high_rate(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """바운스율이 임계를 2사이클 연속 넘으면 이상치 WARN. 1사이클만으론 안 낸다."""
    counter = {"v": 0}
    kis = _BouncingKis(counter, bumps_per_fetch=1)  # 1종목 1바운스 = 100% > 25%
    recorder = _make_recorder(tmp_path, counter, kis, {"005930"})

    with caplog.at_level("WARNING", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()  # streak=1, WARN 없음
        after_first = [r for r in caplog.records if "rate_limit_anomaly" in r.getMessage()]
        assert after_first == []
        await recorder.poll_once()  # streak=2 → WARN

    anomaly = [r for r in caplog.records if "rate_limit_anomaly" in r.getMessage()]
    assert len(anomaly) == 1


@pytest.mark.asyncio
async def test_rest30_anomaly_streak_resets_on_normal_cycle(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """정상(저바운스) 사이클이 끼면 연속 카운터가 리셋돼 경보가 안 뜬다."""
    counter = {"v": 0}
    kis = _BouncingKis(counter, bumps_per_fetch=1)
    recorder = _make_recorder(tmp_path, counter, kis, {"005930"})

    with caplog.at_level("WARNING", logger="hoga.live.rest30_recorder"):
        await recorder.poll_once()  # streak=1
        kis._bumps = 0  # 다음 사이클은 무바운스
        await recorder.poll_once()  # streak 리셋 → 0
        kis._bumps = 1
        await recorder.poll_once()  # streak=1 (연속 아님)

    anomaly = [r for r in caplog.records if "rate_limit_anomaly" in r.getMessage()]
    assert anomaly == []
