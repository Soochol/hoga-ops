from __future__ import annotations

import json
from datetime import datetime

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from hoga.live.second_trade_agg import SecondTradeBar, aggregate_bars
from hoga.live.second_trade_api import build_router
from hoga.live.second_trade_store import SecondTradeStore, second_trade_store
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick
from hoga.util.timeenc import KST

T = int(datetime(2026, 9, 30, 9, tzinfo=KST).timestamp() * 1000)


def tick(t=T, price=100, qty=2, side=1, venue="KRX"):
    return WsTick("005930", t, SnapshotKind.TRADE,
                  {"trades": [{"t_ms": t, "price": price, "qty": qty, "side": side}]}, venue)


def test_ohlc_event_order_receive_ties_and_identical_trades():
    bar = SecondTradeBar(T)
    for seq, t, p, q, side in [(1, T+500, 110, 2, 1), (2, T+100, 100, 3, -1),
                               (3, T+500, 105, 4, 0), (4, T+500, 105, 4, 0)]:
        bar.ingest(t_ms=t, seq=seq, price=p, qty=q, side=side)
    assert (bar.open, bar.high, bar.low, bar.close, bar.volume, bar.count) == (100, 110, 100, 105, 13, 4)
    assert bar.prices[(105, 0)] == [8, 2]
    assert SecondTradeBar.restore(bar.record()).record() == bar.record()


@pytest.mark.parametrize("seconds", [1, 5, 10, 30])
def test_rebucket_boundary_and_volume(seconds):
    rows = []
    for seq, offset, price in [(1, 0, 100), (2, seconds*1000-1, 110), (3, seconds*1000, 90)]:
        bar = SecondTradeBar((T+offset)//1000*1000)
        bar.ingest(t_ms=T+offset, seq=seq, price=price, qty=2, side=1)
        rows.append(bar.record())
    out = aggregate_bars(rows, seconds*1000)
    assert len(out) == 2
    assert (out[0]["open"], out[0]["close"], out[0]["volume"]) == (100, 110, 4)
    assert out[1]["volume"] == 2


@pytest.mark.asyncio
async def test_retry_late_replay_venue_isolation_and_torn_tail(tmp_path, monkeypatch):
    store = SecondTradeStore(tmp_path)
    store._sealed_before = T-1000
    store.ingest(tick())
    store.ingest(tick(venue="NXT", price=200))
    original = store._append
    failed = False

    def uncertain(path, rows):
        nonlocal failed
        original(path, rows)
        if not failed:
            failed = True
            raise OSError("uncertain acknowledgement")

    monkeypatch.setattr(store, "_append", uncertain)
    await store.flush(now_ms=T+61_000)
    await store.flush(now_ms=T+62_000)
    store.ingest(tick(T+500, price=120, qty=3))
    await store.flush(now_ms=T+63_000)
    path = store.path("005930", "KRX", "20260930")
    rows = store.disk_rows("005930", "KRX", "20260930")
    assert rows[0]["volume"] == 5
    assert rows[0]["close"] == 120
    assert store.disk_rows("005930", "NXT", "20260930")[0]["volume"] == 2
    # A checkpoint containing the applied late event must not apply it again.
    original(path, [{"kind": "bar", "bar": rows[0]}])
    assert SecondTradeStore._replay(path)[T]["volume"] == 5
    with path.open("a") as out:
        out.write('{"kind":')
    original(path, [{"kind": "bar", "bar": rows[0]}])
    assert SecondTradeStore._replay(path)[T]["volume"] == 5


@pytest.mark.asyncio
async def test_bounded_queue_and_validation(tmp_path):
    store = SecondTradeStore(tmp_path, max_cells=1)
    store._sealed_before = T-1000
    store.ingest(tick())
    store.ingest(tick(qty=0))
    store.ingest(tick(price=101))
    assert store._cells == 1
    assert store.storage_error == "second_trade_queue_full"
    assert store.live_rows("005930", "KRX", "20260930")[0]["volume"] == 2
    await store.flush(now_ms=T+61_000)
    assert store._cells == 0


def test_api_observed_only_empty_validation_and_shared_prices(tmp_path):
    store = second_trade_store(tmp_path)
    store._sealed_before = T-1000
    store.ingest(tick())
    store.ingest(tick(T+1000, price=105, qty=3, side=-1))
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    url = "/api/live/second-aggregates?code=005930&date=20260930&include_prices=true"
    response = client.get(url)
    assert response.status_code == 200
    data = response.json()
    assert data["coverage"] == "unverified"
    assert data["bars"][0]["volume"] == sum(p["qty"] for p in data["prices"]) == 5
    assert data["bars"][0]["close"] == 105
    assert client.get(url.replace("005930", "000660")).json()["status"] == "unavailable"
    assert client.get(url.replace("20260930", "20260931")).status_code == 422
    for seconds in (1, 5, 10, 30):
        explicit = client.get(url+f"&seconds={seconds}")
        assert explicit.status_code == 200
        assert explicit.json()["seconds"] == seconds
    assert client.get(url+"&seconds=2").status_code == 422


@pytest.mark.asyncio
async def test_publish_two_tables_manifest(tmp_path):
    import pyarrow.parquet as pq

    store = SecondTradeStore(tmp_path)
    store._sealed_before = T-1000
    store.ingest(tick())
    await store.flush(now_ms=T+5000)
    generation = store.publish("005930", "KRX", "20260930")
    assert generation is not None
    manifest = json.loads((generation.parent / "manifest.json").read_text())
    assert manifest["generation"] == generation.name
    assert pq.read_table(generation / "trade_seconds.parquet")["volume"].to_pylist() == [2]
    assert pq.read_table(generation / "trade_second_prices.parquet")["qty"].to_pylist() == [2]


@pytest.mark.asyncio
async def test_restart_respects_memory_limit_and_preserves_durable_revision(tmp_path, monkeypatch):
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T+30_000)/1000)
    original = SecondTradeStore(tmp_path)
    original.ingest(tick(price=100))
    original.ingest(tick(price=110))
    await original.flush(now_ms=T+5000)
    recovered = SecondTradeStore(tmp_path, max_cells=1)
    await recovered.prepare(["005930"])
    assert recovered.storage_error == "second_trade_queue_full"
    assert recovered._cells <= 1
    recovered.ingest(tick(T+500, price=120))
    await recovered.flush(now_ms=T+6000)
    assert recovered.disk_rows("005930", "KRX", "20260930")[0]["volume"] == 4


@pytest.mark.asyncio
async def test_checkpoint_restart_and_generation_tail(tmp_path, monkeypatch):
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T+30_000)/1000)
    store = SecondTradeStore(tmp_path)
    store.ingest(tick())
    await store.flush(now_ms=T+5000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    recovered.ingest(tick(T+500, price=110, qty=3))
    await recovered.flush(now_ms=T+6000)
    assert recovered.live_rows("005930", "KRX", "20260930")[0]["volume"] == 5
    recovered.publish("005930", "KRX", "20260930")
    cold_reader = SecondTradeStore(tmp_path)
    assert cold_reader.disk_rows("005930", "KRX", "20260930")[0]["volume"] == 5
    recovered.ingest(tick(T+1000, qty=4))
    await recovered.flush(now_ms=T+7000)
    assert sum(r["volume"] for r in cold_reader.disk_rows("005930", "KRX", "20260930")) == 9


@pytest.mark.asyncio
async def test_stream_receives_seconds_before_display_await_and_retains_legacy(tmp_path):
    from hoga.live.buffer import LiveBuffer
    from hoga.live.stream import LiveStream
    from hoga.live.writer import LiveWriter

    store = SecondTradeStore(tmp_path / "seconds")
    store._sealed_before = T-1000
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path / "legacy"),
                        date_fn=lambda: "20260930", phase_fn=lambda: "regular", seconds=store)
    stream.set_active_codes({"005930"})
    await stream.on_tick(tick())
    assert not store.live_rows("005930", "KRX", "20260930")
    stream._open_venues = frozenset({"KRX"})
    await stream.on_tick(tick())
    await stream.on_tick(tick(T+500, qty=3, price=110))
    await stream.flush_once(now_ms=T+10_000)
    assert store.disk_rows("005930", "KRX", "20260930")[0]["volume"] == 5
    assert (tmp_path / "legacy/20260930/KRX/005930.jsonl").exists()


@pytest.mark.asyncio
async def test_recovery_failure_isolated_from_legacy(tmp_path, monkeypatch):
    store = SecondTradeStore(tmp_path)
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: T/1000)

    def fail(*_):
        raise OSError("permission denied")

    monkeypatch.setattr(store, "_read_recent", fail)
    await store.prepare(["005930"])
    store.ingest(tick())
    assert store.storage_error == "second_trade_recovery_error"
    assert not store.live_rows("005930", "KRX", "20260930")


@pytest.mark.asyncio
async def test_generation_watermark_never_consumes_a_partial_append(tmp_path):
    store = SecondTradeStore(tmp_path)
    store._sealed_before = T-1000
    store.ingest(tick())
    await store.flush(now_ms=T+5000)
    path = store.path("005930", "KRX", "20260930")
    next_bar = SecondTradeBar(T+1000)
    next_bar.ingest(t_ms=T+1000, seq=10, price=110, qty=3, side=1)
    line = json.dumps({"kind": "bar", "bar": next_bar.record()})+"\n"
    with path.open("a") as out:
        out.write(line[:20])
    generation = store.publish("005930", "KRX", "20260930")
    assert generation is not None
    with path.open("a") as out:
        out.write(line[20:])
    assert sum(row["volume"] for row in store.disk_rows("005930", "KRX", "20260930")) == 5
