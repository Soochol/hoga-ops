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
    ], now_ms=1)
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
        ], now_ms=t)
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
        ], now_ms=tick)
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
                now_ms=i,
            )
            for i in range(100)
        )
    )
    series = await buf.get_series("005930")
    assert len(series["snapshots"]) == 100


@pytest.mark.asyncio
async def test_per_code_isolation() -> None:
    buf = LiveBuffer()
    await buf.publish("005930", [_snap(1, SnapshotKind.OB, {"x": 1})], now_ms=1)
    await buf.publish("000660", [_snap(1, SnapshotKind.OB, {"x": 2})], now_ms=1)
    a = await buf.get_latest("005930")
    b = await buf.get_latest("000660")
    assert a is not None and a["orderbook"] == {"x": 1}
    assert b is not None and b["orderbook"] == {"x": 2}


@pytest.mark.asyncio
async def test_subscribe_receives_published_entries() -> None:
    """A subscriber gets each entry published for its code."""
    buf = LiveBuffer()
    q = buf.subscribe("005930")
    try:
        await buf.publish("005930", [
            _snap(1, SnapshotKind.OB, {"x": 1}),
            _snap(1, SnapshotKind.TRADE, {"trades": []}),
            _snap(1, SnapshotKind.BROKER, {}),
        ])
        # Three entries received in order
        for _ in range(3):
            entry = await asyncio.wait_for(q.get(), timeout=1.0)
            assert entry["t_ms"] == 1
    finally:
        buf.unsubscribe("005930", q)


@pytest.mark.asyncio
async def test_subscribe_filters_by_code() -> None:
    """Subscriber for 005930 doesn't see 000660 publishes."""
    buf = LiveBuffer()
    q = buf.subscribe("005930")
    try:
        await buf.publish("000660", [_snap(1, SnapshotKind.OB, {"x": 99})])
        # No item should arrive — wait_for times out
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(q.get(), timeout=0.05)
    finally:
        buf.unsubscribe("005930", q)


@pytest.mark.asyncio
async def test_unsubscribe_removes_queue() -> None:
    buf = LiveBuffer()
    q = buf.subscribe("005930")
    buf.unsubscribe("005930", q)
    # Subsequent publish must not raise (no subscribers left)
    await buf.publish("005930", [_snap(1, SnapshotKind.OB, {})])


@pytest.mark.asyncio
async def test_publish_evicts_by_time() -> None:
    buf = LiveBuffer(retention_ms=900_000)
    old = LiveSnapshot(t_ms=1_000, kind=SnapshotKind.OB, payload={"code": "005930"})
    new = LiveSnapshot(t_ms=2_000_000, kind=SnapshotKind.OB, payload={"code": "005930"})
    await buf.publish("005930", [old], now_ms=1_000)
    await buf.publish("005930", [new], now_ms=2_000_000)   # old(1초)는 컷오프 밖
    series = await buf.get_series("005930")
    t_list = [e["t_ms"] for e in series["snapshots"]]
    assert 1_000 not in t_list and 2_000_000 in t_list


# ── drop_codes_except 테스트 3건 (Task 11 / Task 4 리뷰 Minor 3) ──────────────

@pytest.mark.asyncio
async def test_drop_codes_except_removes_evicted_keeps_retained() -> None:
    """① drop_codes_except가 keep 밖 코드의 모든 kind deque를 제거하고
    keep 코드는 보존."""
    buf = LiveBuffer()
    # 두 코드에 두 kind씩 publish
    await buf.publish("005930", [
        _snap(1, SnapshotKind.OB, {"x": 1}),
        _snap(1, SnapshotKind.TRADE, {"trades": []}),
    ], now_ms=1_000)
    await buf.publish("000660", [
        _snap(1, SnapshotKind.OB, {"x": 2}),
        _snap(1, SnapshotKind.TRADE, {"trades": []}),
    ], now_ms=1_000)

    # 005930만 keep — 000660은 축출
    await buf.drop_codes_except({"005930"})

    # 보존 코드는 데이터 온전
    assert await buf.get_latest("005930") is not None
    # 축출 코드는 사라짐
    assert await buf.get_latest("000660") is None


@pytest.mark.asyncio
async def test_publish_eviction_boundary_at_cutoff() -> None:
    """② eviction 경계 pin — t_ms == cutoff인 엔트리는 유지,
    cutoff - 1은 제거(< 의미론 고정)."""
    retention_ms = 100_000
    buf = LiveBuffer(retention_ms=retention_ms)
    now_ms = 200_000
    cutoff = now_ms - retention_ms  # == 100_000

    stale = _snap(cutoff - 1, SnapshotKind.OB, {"label": "stale"})    # 제거 대상
    boundary = _snap(cutoff, SnapshotKind.OB, {"label": "boundary"})  # 유지 대상
    fresh = _snap(now_ms, SnapshotKind.OB, {"label": "fresh"})

    await buf.publish("005930", [stale, boundary, fresh], now_ms=now_ms)
    series = await buf.get_series("005930")
    t_list = [e["t_ms"] for e in series["snapshots"]]
    assert (cutoff - 1) not in t_list      # stale 제거
    assert cutoff in t_list                # boundary 유지 (< 의미론)
    assert now_ms in t_list               # fresh 유지


@pytest.mark.asyncio
async def test_publish_mixed_kind_independent_eviction() -> None:
    """③ mixed-kind 배치([OB, TRADE]) publish 시 각 kind deque가
    독립적으로 eviction."""
    retention_ms = 50_000
    buf = LiveBuffer(retention_ms=retention_ms)
    now_ms = 100_000
    cutoff = now_ms - retention_ms  # == 50_000

    # OB: 오래된 것과 새 것 함께 publish
    # TRADE: 새 것만 publish
    await buf.publish("005930", [
        _snap(cutoff - 1, SnapshotKind.OB, {"label": "old_ob"}),
        _snap(now_ms, SnapshotKind.OB, {"label": "new_ob"}),
        _snap(now_ms, SnapshotKind.TRADE, {"trades": [{"label": "new_trade"}]}),
    ], now_ms=now_ms)

    series = await buf.get_series("005930")
    ob_times = [e["t_ms"] for e in series["snapshots"]]
    trade_times = [e["t_ms"] for e in series["trades"]]

    # OB: stale 제거, fresh 유지
    assert (cutoff - 1) not in ob_times
    assert now_ms in ob_times
    # TRADE: fresh 유지, 독립적으로 관리
    assert now_ms in trade_times
