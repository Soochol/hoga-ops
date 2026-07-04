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
