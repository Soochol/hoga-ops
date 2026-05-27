"""Stage 7-β — In-memory ring buffer for live snapshots."""
import asyncio

import pytest

from hoga.live.buffer import LiveBuffer, MAX_BUFFER_ENTRIES
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def _snap(t_ms: int, kind: SnapshotKind, payload: dict | None = None) -> LiveSnapshot:
    return LiveSnapshot(t_ms=t_ms, kind=kind, payload=payload or {})


@pytest.mark.asyncio
async def test_publish_and_read_latest() -> None:
    buf = LiveBuffer()
    await buf.publish("005930", [
        _snap(1, SnapshotKind.OB, {"asks": [], "bids": []}),
        _snap(1, SnapshotKind.TRADE, {"trades": [{"price": 100}]}),
        _snap(1, SnapshotKind.BROKER, {"buy_top": []}),
    ])
    latest = await buf.get_latest("005930")
    assert latest is not None
    assert latest["t_ms"] == 1
    assert latest["orderbook"] == {"asks": [], "bids": []}
    assert latest["recent_trades"] == [{"price": 100}]
    assert latest["brokers"] == {"buy_top": []}


@pytest.mark.asyncio
async def test_get_latest_returns_none_for_unknown_code() -> None:
    buf = LiveBuffer()
    assert await buf.get_latest("999999") is None


@pytest.mark.asyncio
async def test_get_series_returns_all_published() -> None:
    buf = LiveBuffer()
    for tick in range(3):
        t = (tick + 1) * 10_000
        await buf.publish("005930", [
            _snap(t, SnapshotKind.OB, {"total_bid_qty": 100 + tick}),
            _snap(t, SnapshotKind.TRADE, {"trades": [{"qty": tick}]}),
            _snap(t, SnapshotKind.BROKER, {"buy_top": []}),
        ])
    series = await buf.get_series("005930")
    assert series["code"] == "005930"
    assert len(series["snapshots"]) == 3
    assert len(series["trades"]) == 3
    assert len(series["brokers"]) == 3
    assert series["snapshots"][0]["total_bid_qty"] == 100
    assert series["snapshots"][2]["total_bid_qty"] == 102


@pytest.mark.asyncio
async def test_buffer_caps_at_MAX_BUFFER_ENTRIES_per_kind() -> None:
    buf = LiveBuffer()
    # Publish MAX + 50 of each kind for one code
    for tick in range(MAX_BUFFER_ENTRIES + 50):
        await buf.publish("005930", [
            _snap(tick, SnapshotKind.OB, {"i": tick}),
            _snap(tick, SnapshotKind.TRADE, {"trades": []}),
            _snap(tick, SnapshotKind.BROKER, {}),
        ])
    series = await buf.get_series("005930")
    assert len(series["snapshots"]) == MAX_BUFFER_ENTRIES
    # FIFO drop: oldest is no longer at index 0; the earliest retained is
    # the 50th entry we published.
    assert series["snapshots"][0]["i"] == 50


@pytest.mark.asyncio
async def test_concurrent_publish_serialized() -> None:
    buf = LiveBuffer()
    await asyncio.gather(
        *(
            buf.publish(
                "005930",
                [_snap(i, SnapshotKind.OB, {"i": i})],
            )
            for i in range(100)
        )
    )
    series = await buf.get_series("005930")
    assert len(series["snapshots"]) == 100


@pytest.mark.asyncio
async def test_per_code_isolation() -> None:
    buf = LiveBuffer()
    await buf.publish("005930", [_snap(1, SnapshotKind.OB, {"x": 1})])
    await buf.publish("000660", [_snap(1, SnapshotKind.OB, {"x": 2})])
    a = await buf.get_latest("005930")
    b = await buf.get_latest("000660")
    assert a is not None and a["orderbook"] == {"x": 1}
    assert b is not None and b["orderbook"] == {"x": 2}
