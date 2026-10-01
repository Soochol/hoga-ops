from __future__ import annotations

import asyncio
import json
from datetime import datetime

import pytest

from hoga.live.second_trade_agg import SecondTradeBar
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.snapshot import SnapshotKind
from hoga.live.ticks import WsTick
from hoga.util.timeenc import KST

T = int(datetime(2026, 10, 1, 9, tzinfo=KST).timestamp() * 1000)
DATE = "20261001"


def tick(t=T, *, code="005930", qty=2, price=100, venue="KRX"):
    return WsTick(code, t, SnapshotKind.TRADE,
                  {"trades": [{"t_ms": t, "price": price, "qty": qty, "side": 1}]}, venue)


def store_at(root):
    store = SecondTradeStore(root)
    store._sealed_before = T - 1000
    return store


@pytest.mark.asyncio
async def test_checkpoint_reuses_unchanged_seconds_and_isolates_dirty_files(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    calls = []
    original = SecondTradeBar.record

    def record(bar):
        calls.append(bar.t_ms)
        return original(bar)

    monkeypatch.setattr(SecondTradeBar, "record", record)
    store.ingest(tick())
    store.ingest(tick(T + 1000))
    store.ingest(tick(code="000660"))
    await store.flush(now_ms=T + 5000)
    assert len(calls) == 3
    other = store.path("000660", "KRX", DATE)
    other_journal = other.read_bytes()
    other_checkpoint = other.with_suffix(".recent.json").read_bytes()
    await store.flush(now_ms=T + 6000)
    assert len(calls) == 3  # No new records, journal append or checkpoint.
    store.ingest(tick(T + 2000, price=110))
    await store.flush(now_ms=T + 7000)
    assert calls[-1] == T + 2000 and len(calls) == 4
    assert other.read_bytes() == other_journal
    assert other.with_suffix(".recent.json").read_bytes() == other_checkpoint
    store.ingest(tick(T + 500, qty=3, price=120))
    await store.flush(now_ms=T + 8000)
    assert calls[-1] == T and len(calls) == 5
    checkpoint = json.loads(store.path("005930", "KRX", DATE).with_suffix(".recent.json").read_text())
    assert [row["volume"] for row in checkpoint["bars"]] == [5, 2, 2]
    assert checkpoint["bars"][0]["prices"] == [[100, 1, 2, 1], [120, 1, 3, 1]]
    # Public rows are independent mutable values, never the private snapshots.
    public = store.live_rows("005930", "KRX", DATE)
    public[0]["prices"][0][2] = 999
    store.ingest(tick(T + 3000))
    await store.flush(now_ms=T + 9000)
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 5
    assert store.disk_rows("005930", "KRX", DATE)[0]["prices"][0][2] == 2
    await store.flush(now_ms=T + 70_000)
    assert not store._bars and not store._flush_records and store._cells == 0


@pytest.mark.asyncio
async def test_ingest_during_append_does_not_change_checkpoint_or_ack_new_revision(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick())
    original = asyncio.to_thread
    interleaved = False

    async def to_thread(fn, *args):
        nonlocal interleaved
        if fn == store._append and not interleaved:
            interleaved = True
            store.ingest(tick(T + 500, qty=3, price=110))
            store.ingest(tick(T + 1000, qty=4))
        return await original(fn, *args)

    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    await store.flush(now_ms=T + 5000)
    path = store.path("005930", "KRX", DATE)
    saved = json.loads(path.with_suffix(".recent.json").read_text())
    assert saved["bars"][0]["volume"] == 2
    assert store._saved[("005930", "KRX", T)] == 1
    assert store._bars[("005930", "KRX", T)].revision == 2
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 2
    await store.flush(now_ms=T + 6000)
    assert sum(row["volume"] for row in store.disk_rows("005930", "KRX", DATE)) == 9
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 7000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    assert sum(row["volume"] for row in recovered.live_rows("005930", "KRX", DATE)) == 9


@pytest.mark.asyncio
async def test_uncertain_append_and_new_revision_retry_without_double_count(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick())
    original = store._append
    failed = False

    def append(path, rows):
        nonlocal failed
        original(path, rows)
        if not failed:
            failed = True
            raise OSError("fsync acknowledgement lost")

    monkeypatch.setattr(store, "_append", append)
    await store.flush(now_ms=T + 5000)
    assert not store._saved
    store.ingest(tick(T + 500, qty=3))
    await store.flush(now_ms=T + 6000)
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 5
    assert store._saved[("005930", "KRX", T)] == 2


@pytest.mark.asyncio
async def test_late_trade_arriving_during_append_remains_pending(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick())
    await store.flush(now_ms=T + 61_000)
    store.ingest(tick(T + 500, qty=3))
    original = asyncio.to_thread
    interleaved = False

    async def to_thread(fn, *args):
        nonlocal interleaved
        if fn == store._append and not interleaved:
            interleaved = True
            store.ingest(tick(T + 700, qty=4))
        return await original(fn, *args)

    monkeypatch.setattr(asyncio, "to_thread", to_thread)
    await store.flush(now_ms=T + 62_000)
    assert store._late_count == 1
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 5
    await store.flush(now_ms=T + 63_000)
    assert store._late_count == 0
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 9


@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.asyncio
async def test_large_preparation_yields_to_ingest_and_cancel_preserves_pending(tmp_path, monkeypatch, cancel):
    store = store_at(tmp_path)
    codes = [f"{i:06}" for i in range(320)]
    for code in codes:
        store.ingest(tick(code=code))
    seen = asyncio.Event()
    calls = 0
    control_at = None
    original = SecondTradeBar.record

    def record(bar):
        nonlocal calls
        calls += 1
        seen.set()
        return original(bar)

    monkeypatch.setattr(SecondTradeBar, "record", record)
    flush = asyncio.create_task(store.flush(now_ms=T + 5000))

    async def control():
        nonlocal control_at
        await seen.wait()
        control_at = calls
        store.ingest(tick(code="999999", qty=3))
        store.ingest(tick(code=codes[0], qty=4))
        if cancel:
            flush.cancel()

    task = asyncio.create_task(control())
    if cancel:
        with pytest.raises(asyncio.CancelledError):
            await flush
        assert not store._saved and not list(tmp_path.rglob("*.jsonl"))
    else:
        await flush
        assert store._saved[(codes[0], "KRX", T)] == 1
        assert not store.path("999999", "KRX", DATE).exists()
    await task
    assert 0 < control_at < len(codes)  # Deterministic fairness, no timing threshold.
    await store.flush(now_ms=T + 6000)
    assert store.disk_rows(codes[0], "KRX", DATE)[0]["volume"] == 6
    assert store.disk_rows("999999", "KRX", DATE)[0]["volume"] == 3
    assert len(store._flush_records) <= len(store._bars)


@pytest.mark.asyncio
async def test_force_flush_includes_young_bars(tmp_path):
    store = store_at(tmp_path)
    store.ingest(tick())
    await store.flush(now_ms=T + 1000)
    assert not store._saved
    await store.flush(now_ms=T + 1000, force=True)
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 2
