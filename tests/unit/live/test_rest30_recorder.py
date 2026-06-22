from __future__ import annotations

from pathlib import Path

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
        return [KisTrade(price=100, qty=3, side=1, side_source="inferred", t_ms=1770000000000)]

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
