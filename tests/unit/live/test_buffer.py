"""Stage 7-β — In-memory ring buffer for live snapshots."""

import asyncio

import pytest

from hoga.live.buffer import MAX_BUFFER_ENTRIES, LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def _snap(t_ms: int, kind: SnapshotKind, payload: dict | None = None) -> LiveSnapshot:
    return LiveSnapshot(t_ms=t_ms, kind=kind, payload=payload or {})


@pytest.mark.asyncio
async def test_publish_and_read_latest() -> None:
    buf = LiveBuffer()
    await buf.publish(
        "005930",
        [
            _snap(1, SnapshotKind.OB, {"asks": [], "bids": []}),
            _snap(1, SnapshotKind.TRADE, {"trades": [{"price": 100}]}),
            _snap(1, SnapshotKind.BROKER, {"buy_top": []}),
        ],
        now_ms=1,
    )
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
        await buf.publish(
            "005930",
            [
                _snap(t, SnapshotKind.OB, {"total_bid_qty": 100 + tick}),
                _snap(t, SnapshotKind.TRADE, {"trades": [{"qty": tick}]}),
                _snap(t, SnapshotKind.BROKER, {"buy_top": []}),
                _snap(
                    t,
                    SnapshotKind.PROGRAM,
                    {"net_qty": 10 + tick, "net_amount": 1_000_000 + tick},
                ),
            ],
            now_ms=t,
        )
    series = await buf.get_series("005930")
    assert series["code"] == "005930"
    assert len(series["snapshots"]) == 3
    assert len(series["trades"]) == 3
    assert len(series["brokers"]) == 3
    assert len(series["programs"]) == 3
    assert series["snapshots"][0]["total_bid_qty"] == 100
    assert series["snapshots"][2]["total_bid_qty"] == 102
    assert series["programs"][0]["kind"] == "program"
    assert series["programs"][2]["net_qty"] == 12


@pytest.mark.asyncio
async def test_buffer_caps_at_MAX_BUFFER_ENTRIES_per_kind() -> None:
    buf = LiveBuffer()
    # Publish MAX + 50 of each kind for one code
    for tick in range(MAX_BUFFER_ENTRIES + 50):
        await buf.publish(
            "005930",
            [
                _snap(tick, SnapshotKind.OB, {"i": tick}),
                _snap(tick, SnapshotKind.TRADE, {"trades": []}),
                _snap(tick, SnapshotKind.BROKER, {}),
            ],
            now_ms=tick,
        )
    series = await buf.get_series("005930")
    assert len(series["snapshots"]) == MAX_BUFFER_ENTRIES
    # FIFO drop: oldest is no longer at index 0; the earliest retained is
    # the 50th entry we published.
    assert series["snapshots"][0]["i"] == 50
    stats = await buf.stats_snapshot()
    assert stats["total_entries"] == MAX_BUFFER_ENTRIES * 3


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
        await buf.publish(
            "005930",
            [
                _snap(1, SnapshotKind.OB, {"x": 1}),
                _snap(1, SnapshotKind.TRADE, {"trades": []}),
                _snap(1, SnapshotKind.BROKER, {}),
                _snap(1, SnapshotKind.PROGRAM, {"net_qty": 10}),
            ],
        )
        received = [await asyncio.wait_for(q.get(), timeout=1.0) for _ in range(4)]
        assert [entry["kind"] for entry in received] == [
            "ob",
            "trade",
            "broker",
            "program",
        ]
        assert all(entry["t_ms"] == 1 for entry in received)
    finally:
        buf.unsubscribe("005930", q)


@pytest.mark.asyncio
async def test_stats_track_subscriber_overflow_drop() -> None:
    buf = LiveBuffer()
    q = buf.subscribe("005930")
    try:
        await buf.publish(
            "005930",
            [_snap(t_ms, SnapshotKind.OB, {"x": t_ms}) for t_ms in range(1_025)],
            now_ms=1_024,
        )
        stats = await buf.stats_snapshot()
        assert stats["subscriber_drops"] == 1
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
    await buf.publish("005930", [new], now_ms=2_000_000)  # old(1초)는 컷오프 밖
    series = await buf.get_series("005930")
    t_list = [e["t_ms"] for e in series["snapshots"]]
    assert 1_000 not in t_list and 2_000_000 in t_list


@pytest.mark.asyncio
async def test_stats_track_publish_high_water_and_drop() -> None:
    buf = LiveBuffer(retention_ms=100)
    await buf.publish(
        "005930",
        [
            _snap(100, SnapshotKind.OB, {"x": 1}),
            _snap(100, SnapshotKind.TRADE, {"trades": []}),
        ],
        now_ms=100,
    )
    first = await buf.stats_snapshot()
    assert first["published_total"] == 2
    assert first["total_entries"] == 2
    assert first["high_water_entries"] == 2

    await buf.publish(
        "005930",
        [_snap(1_000, SnapshotKind.OB, {"x": 2})],
        now_ms=1_000,
    )
    second = await buf.stats_snapshot()
    assert second["published_total"] == 3
    assert second["total_entries"] == 2
    assert second["high_water_entries"] == 2


# ── drop_codes_except 테스트 3건 (Task 11 / Task 4 리뷰 Minor 3) ──────────────


@pytest.mark.asyncio
async def test_drop_codes_except_removes_evicted_keeps_retained() -> None:
    """① drop_codes_except가 keep 밖 코드의 모든 kind deque를 제거하고
    keep 코드는 보존."""
    buf = LiveBuffer()
    # 두 코드에 두 kind씩 publish
    await buf.publish(
        "005930",
        [
            _snap(1, SnapshotKind.OB, {"x": 1}),
            _snap(1, SnapshotKind.TRADE, {"trades": []}),
        ],
        now_ms=1_000,
    )
    await buf.publish(
        "000660",
        [
            _snap(1, SnapshotKind.OB, {"x": 2}),
            _snap(1, SnapshotKind.TRADE, {"trades": []}),
        ],
        now_ms=1_000,
    )

    # 005930만 keep — 000660은 축출
    await buf.drop_codes_except({"005930"})

    # 보존 코드는 데이터 온전
    assert await buf.get_latest("005930") is not None
    # 축출 코드는 사라짐
    assert await buf.get_latest("000660") is None
    stats = await buf.stats_snapshot()
    assert stats["total_entries"] == 2


@pytest.mark.asyncio
async def test_publish_eviction_boundary_at_cutoff() -> None:
    """② eviction 경계 pin — t_ms == cutoff인 엔트리는 유지,
    cutoff - 1은 제거(< 의미론 고정)."""
    retention_ms = 100_000
    buf = LiveBuffer(retention_ms=retention_ms)
    now_ms = 200_000
    cutoff = now_ms - retention_ms  # == 100_000

    stale = _snap(cutoff - 1, SnapshotKind.OB, {"label": "stale"})  # 제거 대상
    boundary = _snap(cutoff, SnapshotKind.OB, {"label": "boundary"})  # 유지 대상
    fresh = _snap(now_ms, SnapshotKind.OB, {"label": "fresh"})

    await buf.publish("005930", [stale, boundary, fresh], now_ms=now_ms)
    series = await buf.get_series("005930")
    t_list = [e["t_ms"] for e in series["snapshots"]]
    assert (cutoff - 1) not in t_list  # stale 제거
    assert cutoff in t_list  # boundary 유지 (< 의미론)
    assert now_ms in t_list  # fresh 유지


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
    await buf.publish(
        "005930",
        [
            _snap(cutoff - 1, SnapshotKind.OB, {"label": "old_ob"}),
            _snap(now_ms, SnapshotKind.OB, {"label": "new_ob"}),
            _snap(now_ms, SnapshotKind.TRADE, {"trades": [{"label": "new_trade"}]}),
        ],
        now_ms=now_ms,
    )

    series = await buf.get_series("005930")
    ob_times = [e["t_ms"] for e in series["snapshots"]]
    trade_times = [e["t_ms"] for e in series["trades"]]

    # OB: stale 제거, fresh 유지
    assert (cutoff - 1) not in ob_times
    assert now_ms in ob_times
    # TRADE: fresh 유지, 독립적으로 관리
    assert now_ms in trade_times


# ── deque 하드캡 = 보존창 파생 폭주 안전핀 (실측 근거) ────────────────────────
#
# 이전에는 `MAX_BUFFER_ENTRIES = 60_000` 고정이었다. 실측(2026-07-30,
# live_kiwoom/20260729 · 243종목) (code,kind) 당 15분 창 피크가 **91개**라 캡이
# 660배 느슨했고, 그 상한에 닿는 상황이면 800종목 메모리가 이미 538GiB — 프로세스가
# 훨씬 전에 죽는다. 즉 "안전핀" 이 발화 불가능한 위치에 박혀 있었다.


def test_cap_is_derived_from_retention_not_a_fixed_constant() -> None:
    """보존창을 올리면 캡도 올라간다 — 고정 상수면 캡이 실제 보존량을 잘라낸다."""
    from hoga.live.buffer import (
        BUFFER_CAP_SAFETY_FACTOR,
        DEFAULT_RETENTION_MS,
        MAX_BUFFER_ENTRIES,
        cap_for_retention,
    )

    # 기본 15분: 900s / 10s flush = 90 → × 안전배수
    assert cap_for_retention(DEFAULT_RETENTION_MS) == 90 * BUFFER_CAP_SAFETY_FACTOR
    assert cap_for_retention(DEFAULT_RETENTION_MS) == MAX_BUFFER_ENTRIES
    # 1시간으로 올리면 360 × 배수 — 캡이 보존량을 넘어선 상태가 유지된다.
    assert cap_for_retention(3_600_000) == 360 * BUFFER_CAP_SAFETY_FACTOR
    assert cap_for_retention(3_600_000) > 360
    # 아주 짧은 보존창에도 0 이 되지 않는다.
    assert cap_for_retention(1) >= BUFFER_CAP_SAFETY_FACTOR


def test_buffer_flush_interval_matches_stream() -> None:
    """buffer 의 flush 주기 가정이 stream 의 실제 값과 어긋나면 캡 산식이 틀어진다.

    stream 이 buffer 를 import 하므로 역방향 import 는 순환이라 값을 복제했다 —
    드리프트를 막는 것은 이 테스트뿐이다.
    """
    from hoga.live.buffer import BUFFER_FLUSH_INTERVAL_MS
    from hoga.live.stream import FLUSH_INTERVAL_S

    assert int(FLUSH_INTERVAL_S * 1000) == BUFFER_FLUSH_INTERVAL_MS


@pytest.mark.asyncio
async def test_cap_does_not_bind_at_the_measured_production_cadence() -> None:
    """실측 정상상태(10초 간격 × 15분)에서 캡이 물리지 않아야 한다.

    물리면 화면이 조용히 과거를 잃는다 — 캡은 폭주 전용 안전핀이고 정상 동작에는
    닿지 않아야 한다. 실측 피크 91 vs 캡 360 = 약 4배 여유.
    """
    from hoga.live.buffer import DEFAULT_RETENTION_MS, MAX_BUFFER_ENTRIES

    buf = LiveBuffer()
    base = 1_785_283_200_000
    # 15분 창을 10초 간격으로 꽉 채운다(+ 여유 5분 = 시간 축출도 함께 검증).
    for i in range(120):
        t_ms = base + i * 10_000
        await buf.publish("005930", [_snap(t_ms, SnapshotKind.OB, {"asks": []})], now_ms=t_ms)

    series = await buf.get_series("005930")
    held = len(series["snapshots"])
    stats = await buf.stats_snapshot()

    # 보존창 안의 것만 남는다(캡이 아니라 **시간** 이 결정한다).
    assert held == DEFAULT_RETENTION_MS // 10_000 + 1 == 91
    assert held < MAX_BUFFER_ENTRIES, "정상 cadence 에서 캡이 물렸다"
    assert stats["max_entries_per_deque"] == MAX_BUFFER_ENTRIES


@pytest.mark.asyncio
async def test_instance_cap_follows_its_own_retention() -> None:
    """인스턴스가 쓰는 캡은 자기 보존창에서 나온다(모듈 상수 고정값이 아니다)."""
    from hoga.live.buffer import cap_for_retention

    buf = LiveBuffer(retention_ms=60_000)
    stats = await buf.stats_snapshot()
    assert stats["max_entries_per_deque"] == cap_for_retention(60_000)
