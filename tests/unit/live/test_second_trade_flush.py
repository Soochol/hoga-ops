from __future__ import annotations

import asyncio
import json
import random
import threading
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


@pytest.mark.asyncio
async def test_checkpoint_keeps_durable_revision_of_revised_young_bar(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick(qty=2))
    await store.flush(now_ms=T + 1000, force=True)
    # This revision is still too young for a normal flush. Another eligible
    # second advances the same file's checkpoint beyond the original journal.
    store.ingest(tick(T + 500, qty=3))
    store.ingest(tick(T - 5000, qty=4))
    await store.flush(now_ms=T + 1500)
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 2000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    rows = {row["t_ms"]: row for row in recovered.live_rows("005930", "KRX", DATE)}
    assert rows[T]["volume"] == 2  # Durable revision, never the uncommitted 5.
    assert rows[T - 5000]["volume"] == 4
    recovered.ingest(tick(T + 700, qty=7))
    await recovered.flush(now_ms=T + 6000)
    rows = {row["t_ms"]: row for row in recovered.disk_rows("005930", "KRX", DATE)}
    assert rows[T]["volume"] == 9
    assert rows[T]["revision"] == 2


class IndexedBars(dict):
    """A deterministic guard against going back to a global retained-bar scan."""

    def __init__(self, source):
        super().__init__(source)
        self.reads = []

    def __iter__(self):
        pytest.fail("global bar iteration")

    def items(self):
        pytest.fail("global bar items")

    def values(self):
        pytest.fail("global bar values")

    def __getitem__(self, key):
        self.reads.append(key)
        return super().__getitem__(key)


@pytest.mark.asyncio
async def test_idle_and_single_dirty_bar_never_scan_other_retained_bars(tmp_path):
    store = store_at(tmp_path)
    for code in range(300):
        store.ingest(tick(code=f"{code:06}"))
    await store.flush(now_ms=T + 5000)
    store._bars = IndexedBars(store._bars)
    await store.flush(now_ms=T + 6000)
    await store.flush(now_ms=T + 6500, force=True)
    assert store._bars.reads == []
    store.ingest(tick(T + 500, code="000123", qty=7))
    await store.flush(now_ms=T + 7000)
    assert set(store._bars.reads) == {("000123", "KRX", T)}
    assert store.disk_rows("000123", "KRX", DATE)[0]["volume"] == 9
    assert not store._dirty
    # Expiry must still run with no changes, using deadlines rather than a scan.
    await store.flush(now_ms=T + 61_000)
    assert not store._bars and not store._expiry and not store._file_bars
    assert not store._durable_records and not store._expired_pending


@pytest.mark.asyncio
async def test_young_deadline_and_new_earlier_dirty_bar(tmp_path):
    store = store_at(tmp_path)
    store.ingest(tick())
    store._bars = IndexedBars(store._bars)
    await store.flush(now_ms=T + 1000)
    await store.flush(now_ms=T + 2000)
    assert not store._bars.reads
    store.ingest(tick(T - 5000, qty=4))
    await store.flush(now_ms=T + 2000)
    assert [r["volume"] for r in store.disk_rows("005930", "KRX", DATE)] == [4]
    assert ("005930", "KRX", T) in store._dirty
    await store.flush(now_ms=T + 3000)
    assert sum(r["volume"] for r in store.disk_rows("005930", "KRX", DATE)) == 6
    assert not store._dirty


@pytest.mark.asyncio
async def test_failed_expired_bar_remains_dirty_until_its_current_revision_is_durable(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick())
    append = store._append

    def fail(*_args):
        raise OSError("disk unavailable")

    monkeypatch.setattr(store, "_append", fail)
    await store.flush(now_ms=T + 61_000)
    assert store._expired_pending == {("005930", "KRX", T)}
    assert len(store._dirty) == 1
    store.ingest(tick(T + 500, qty=3))
    await store.flush(now_ms=T + 62_000)
    assert store._bars[("005930", "KRX", T)].volume == 5
    monkeypatch.setattr(store, "_append", append)
    await store.flush(now_ms=T + 63_000)
    assert not store._bars and not store._dirty and not store._expiry and not store._expired_pending
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 5


@pytest.mark.asyncio
async def test_dirty_tracking_and_expiry_are_bounded_per_bar_not_per_execution(tmp_path):
    store = store_at(tmp_path)
    for _ in range(10000):
        store.ingest(tick())
    assert len(store._dirty) == len(store._expiry) == len(store._file_bars[("005930", "KRX", DATE)]) == 1
    await store.flush(now_ms=T + 60_000)
    assert len(store._bars) == 1  # Inclusive retention boundary.
    await store.flush(now_ms=T + 60_001)
    assert not store._bars and not store._file_bars
    assert store.disk_rows("005930", "KRX", DATE)[0]["volume"] == 20000


@pytest.mark.asyncio
async def test_uncertain_young_append_is_not_skipped_by_another_bars_checkpoint(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store.ingest(tick())
    append = store._append
    first = True

    def uncertain(path, rows):
        nonlocal first
        append(path, rows)
        if first:
            first = False
            raise OSError("durability acknowledgement lost")

    monkeypatch.setattr(store, "_append", uncertain)
    await store.flush(now_ms=T + 1000, force=True)
    store.ingest(tick(T - 5000, qty=4))
    await store.flush(now_ms=T + 1500)
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 2000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    assert sum(r["volume"] for r in recovered.live_rows("005930", "KRX", DATE)) == 6
    await store.flush(now_ms=T + 3000)
    assert not store._uncertain_files
    assert sum(r["volume"] for r in store.disk_rows("005930", "KRX", DATE)) == 6


@pytest.mark.parametrize("finish", [False, True])
@pytest.mark.asyncio
async def test_cancellation_joins_native_write_and_retains_recoverable_data(tmp_path, monkeypatch, finish):
    store = store_at(tmp_path)
    store.ingest(tick())
    append = store._append
    entered, release = threading.Event(), threading.Event()

    def blocked(path, rows):
        append(path, rows)
        entered.set()
        assert release.wait(5)

    monkeypatch.setattr(store, "_append", blocked)
    write = store.finish_flush if finish else store.flush
    task = asyncio.create_task(write(now_ms=T + 1000, force=True))
    try:
        assert await asyncio.to_thread(entered.wait, 5)
        task.cancel()
        for _ in range(5):
            await asyncio.sleep(0)
        assert not task.done()  # The writer still owns its lock and thread.
    finally:
        release.set()
        with pytest.raises(asyncio.CancelledError):
            await task
    monkeypatch.setattr(store, "_append", append)
    store.ingest(tick(T - 5000, qty=4))
    await store.flush(now_ms=T + 1500)
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 2000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    assert sum(r["volume"] for r in recovered.live_rows("005930", "KRX", DATE)) == 6


@pytest.mark.asyncio
async def test_indexed_flush_matches_all_observed_trades_across_late_data_retry_and_restart(tmp_path, monkeypatch):
    store = store_at(tmp_path)
    store._sealed_before = T - 60_000
    rng = random.Random(17)
    expected = {}
    append = store._append
    fail_next = False

    def intermittent(path, rows):
        nonlocal fail_next
        append(path, rows)
        if fail_next:
            fail_next = False
            raise OSError("uncertain append")

    monkeypatch.setattr(store, "_append", intermittent)
    for i in range(400):
        code = rng.choice(["005930", "000660", "034020"])
        venue = rng.choice(["KRX", "NXT", "UN"])
        at = T + rng.randrange(-120_000, 30_000)
        price, qty = rng.randrange(95, 106), rng.randrange(1, 10)
        store.ingest(tick(at, code=code, venue=venue, price=price, qty=qty))
        key = (code, venue, at // 1000 * 1000)
        bar = expected.setdefault(key, SecondTradeBar(t_ms=key[2]))
        bar.ingest(t_ms=at, seq=store._seq, price=price, qty=qty, side=1)
        if i % 50 == 0:
            fail_next = True
            await store.flush(now_ms=T + i * 10)
    fail_next = False
    await store.flush(now_ms=T + 40_000, force=True)
    assert not store._dirty and not store._late and not store._uncertain_files
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 40_000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930", "000660", "034020"])
    for code in ("005930", "000660", "034020"):
        for venue in ("KRX", "NXT", "UN"):
            rows = {r["t_ms"]: r for r in store.disk_rows(code, venue, DATE)}
            oracle = {k[2]: b.record() for k, b in expected.items() if k[:2] == (code, venue)}
            assert rows.keys() == oracle.keys()
            for at, row in rows.items():
                for name in (
                    "open", "high", "low", "close", "volume", "trade_value", "count", "prices", "first", "last",
                ):
                    assert row[name] == oracle[at][name], (code, venue, at, name)
            recent = {r["t_ms"]: r for r in recovered.live_rows(code, venue, DATE)}
            assert recent.keys() == {at for at in oracle if at >= T - 20_000}
            assert all(r["volume"] == oracle[at]["volume"] for at, r in recent.items())


@pytest.mark.parametrize("after_replace", [False, True])
@pytest.mark.asyncio
async def test_checkpoint_failure_keeps_the_durable_journal_recoverable(tmp_path, monkeypatch, after_replace):
    store = store_at(tmp_path)
    store.ingest(tick())
    await store.flush(now_ms=T + 5000)
    checkpoint = store._checkpoint

    def fail(*args):
        if after_replace:
            checkpoint(*args)
        raise OSError("checkpoint failed")

    monkeypatch.setattr(store, "_checkpoint", fail)
    store.ingest(tick(T + 500, qty=3))
    store.ingest(tick(T + 1000, qty=4))
    await store.flush(now_ms=T + 6000)
    monkeypatch.setattr("hoga.live.second_trade_store.time.time", lambda: (T + 7000) / 1000)
    recovered = SecondTradeStore(tmp_path)
    await recovered.prepare(["005930"])
    assert sum(r["volume"] for r in recovered.live_rows("005930", "KRX", DATE)) == 9
