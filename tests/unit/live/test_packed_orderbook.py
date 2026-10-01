"""Retained book compaction must preserve every public read and delivery boundary."""
import gc
import json

import pytest

from hoga.live.buffer import LiveBuffer
from hoga.live.packed_orderbook import pack_book, unpack_book
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def book():
    return {
        "t_ms": 100, "code": "005930", "phase": "regular", "venue": "NXT",
        "asks": [{"price": 1000 + i, "qty": i} for i in range(10)],
        "bids": [{"price": 999 - i, "qty": 10 - i} for i in range(10)],
        "total_ask_qty": 45, "total_bid_qty": 55,
        "expected_price": 1001, "expected_qty": 3,
        "future_scalar": None,
    }


async def test_reads_and_both_subscription_protocols_preserve_book():
    buf = LiveBuffer()
    legacy = buf.subscribe("005930")
    batch = buf.subscribe("005930", batch=True)
    payload = book()
    await buf.publish("005930", [LiveSnapshot(100, SnapshotKind.OB, payload)], now_ms=100)
    expected = {"t_ms": 100, "kind": "ob", **payload}
    assert json.loads(json.dumps(await legacy.get())) == expected
    delivered = await batch.get()
    assert delivered["data"] == [{**expected, "seq": 1}]
    assert delivered["latest"] == [{**expected, "seq": 1}]
    assert delivered["dropped"] == 0
    series = await buf.get_series("005930")
    assert series["snapshots"] == [expected]
    latest = await buf.get_latest("005930")
    assert latest["orderbook"] == {
        k: v for k, v in expected.items() if k not in ("t_ms", "phase", "kind")
    }
    assert await buf.get_last_ob("005930", "NXT") == expected
    saved, version = await buf.last_ob_snapshot()
    assert saved == {("005930", "NXT"): expected}
    restored = LiveBuffer()
    assert await restored.restore_last_ob(saved) == 1
    assert await restored.get_last_ob("005930", "NXT") == expected
    assert (await restored.last_ob_snapshot())[1] == 0
    assert version == 1


async def test_history_is_independent_of_delivery_mutations_and_can_be_evicted():
    buf = LiveBuffer(retention_ms=10)
    sub = buf.subscribe("005930")
    await buf.publish("005930", [LiveSnapshot(100, SnapshotKind.OB, book())], now_ms=100)
    delivered = await sub.get()
    delivered["asks"][0]["qty"] = 999
    assert (await buf.get_series("005930"))["snapshots"][0]["asks"][0]["qty"] == 0
    latest = await buf.get_last_ob("005930", "NXT")
    latest["bids"].clear()
    assert len((await buf.get_last_ob("005930", "NXT"))["bids"]) == 10
    await buf.publish("005930", [LiveSnapshot(111, SnapshotKind.OB, {})], now_ms=111)
    assert (await buf.get_series("005930"))["snapshots"] == [{"t_ms": 111, "kind": "ob"}]
    assert (await buf.get_last_ob("005930", "NXT"))["t_ms"] == 100
    await buf.drop_codes_except(set())
    assert (await buf.stats_snapshot())["total_entries"] == 0
    assert await buf.get_last_ob("005930", "NXT") is None


@pytest.mark.parametrize("extra", [
    {"future_nested": {"x": [1]}},
    {"asks": [{"price": 1, "qty": 2, "future_level": 3}]},
    {"asks": None}, {"asks": [{"price": 1}]},
])
def test_unknown_payload_containers_and_level_fields_are_preserved(extra):
    payload = {**book(), **extra}
    assert unpack_book(pack_book(payload)) == payload


def test_empty_ladders_missing_fields_and_scalar_types_roundtrip():
    for entry in [{"t_ms": 1}, {"t_ms": 1, "asks": [], "bids": [], "value": False}]:
        assert unpack_book(pack_book(entry)) == entry


def test_retained_scalar_book_becomes_untracked_after_collection():
    packed = pack_book(book())
    assert isinstance(packed, tuple)
    gc.collect()
    gc.collect()
    gc.collect()  # nested tuples shed tracking from their leaves toward the root
    assert not gc.is_tracked(packed)
    assert unpack_book(packed) == book()


async def test_http_serialization_keeps_full_ladders_and_optional_metadata(monkeypatch):
    import httpx
    from fastapi import FastAPI

    from hoga.live import buffer as buffer_module
    from hoga.live.api import build_router

    buf = LiveBuffer()
    payload = book()
    await buf.publish("005930", [LiveSnapshot(100, SnapshotKind.OB, payload)], now_ms=100)
    app = FastAPI()
    selected = [buf]
    app.include_router(build_router(get_status=lambda: None, get_buffer=lambda: selected[0]))
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://test",
    ) as client:
        latest = await client.get("/api/live/snapshot", params={"code": "005930"})
        assert latest.status_code == 200
        assert latest.json()["orderbook"]["asks"] == payload["asks"]
        series = await client.get("/api/live/series", params={
            "code": "005930", "date": "20261001", "venue": "NXT",
        })
        assert series.status_code == 200
        assert series.json()["snapshots"] == [{"t_ms": 100, "kind": "ob", **payload}]
        # Compare the existing HTTP model's filtering, not just buffer dicts.
        baseline = LiveBuffer()
        with monkeypatch.context() as patch:
            patch.setattr(buffer_module, "pack_book", lambda entry: entry)
            await baseline.publish(
                "005930", [LiveSnapshot(100, SnapshotKind.OB, payload)], now_ms=100,
            )
        selected[0] = baseline
        assert (await client.get("/api/live/snapshot", params={"code": "005930"})).json() == latest.json()
        assert (await client.get("/api/live/series", params={
            "code": "005930", "date": "20261001", "venue": "NXT",
        })).json() == series.json()
