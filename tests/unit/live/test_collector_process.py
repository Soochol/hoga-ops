"""Offline spawn/IPC tests: synthetic ticks, private sockets, temporary writers."""
from __future__ import annotations

import asyncio
import contextlib
import os
import socket
import struct
import sys
import time
from datetime import datetime
from pathlib import Path

import pytest

from hoga.live.buffer import LiveBuffer
from hoga.live.collector_ipc import BoundedOutbox, RpcPeer, encode, open_channel, read_frame
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_worker import ForwardBuffer, run_worker
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST

STAMP = int(datetime(2026, 10, 2, 10, tzinfo=KST).timestamp() * 1000)


def trade(i: int) -> WsTick:
    return WsTick("005930", STAMP + i, SnapshotKind.TRADE, {
        "trades": [{"t_ms": STAMP + i, "price": 100 + i % 3, "qty": 1, "side": 1}],
        "cum_volume": i + 1, "padding": "x" * 4096,
    })


async def produce(stream: LiveStream, *, count=1200):
    for i in range(count):
        await stream.on_tick(trade(i))
    await stream.flush_once(now_ms=STAMP + 10_000, seal_candle_venues=frozenset({"KRX"}))


class FakeManager:
    def __init__(self, *, buffer, data_dir, stream_options, **kwargs):
        from hoga.live.second_trade_store import second_trade_store
        self.root = data_dir
        self.stream = LiveStream(buffer=buffer, writer=LiveWriter(data_dir / "live_kiwoom"),
                                 date_fn=lambda: "20261002", phase_fn=lambda: "regular",
                                 seconds=second_trade_store(data_dir), **stream_options)
        self.stream._seconds._sealed_before = STAMP - 60_000
        self.stream._open_venues = frozenset({"KRX"})
        self.stream.set_active_codes({"005930"})
        self.started = False
        self.task = None

    async def sync(self, targets, *, n_accounts):
        if not self.started:
            self.started = True
            await produce(self.stream)
            self.task = asyncio.create_task(self.wait_for_trigger())

    async def wait_for_trigger(self):
        while not (self.root / "trigger").exists():
            await asyncio.sleep(0.01)
        await self.stream.on_tick(trade(2000))
        await self.stream.flush_once(now_ms=STAMP + 20_000)
        (self.root / "child-progress").write_text("stored")

    async def watchdog_pass(self, now_ms):
        pass

    async def on_view_subscribe(self, code, venues, *, ref):
        return True

    async def on_view_unsubscribe(self, code, venues, *, ref):
        pass

    def capture_streams(self):
        return [self.stream]

    def active_codes(self):
        return ["005930"]

    def status(self):
        return {"enabled": True, "accounts_configured": 1, "connected_accounts": 1,
                "subscribed_count": 1, "subscribed_codes": ["005930"], "ready_codes": ["005930"],
                "last_tick_ms": STAMP, "registration_incomplete": False,
                "accounts": [{"account_id": 0, "kicked_by_peer": False}]}

    def sector_snapshot(self):
        return {"test": True}

    def vi_status(self, code):
        return {"code": code, "test": True}

    async def stop(self):
        if self.task is not None:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)


def fake_entry(root, epoch, sockets, parent_pid):
    # No API assembly, credentials, real WS or vendor REST in this subprocess.
    Path(root, "child-imports").write_text(str("hoga.api.app" in sys.modules))
    asyncio.run(run_worker(root, epoch, sockets, parent_pid, manager_factory=FakeManager))


async def until(predicate):
    async with asyncio.timeout(15):
        while not predicate():
            await asyncio.sleep(0.01)


async def test_spawn_storage_independent_of_display_pressure_and_parent_loop(tmp_path, monkeypatch):
    from hoga.api import symbols
    from hoga.live import lifecycle, session_gate
    monkeypatch.setattr(symbols, "nxt_enabled_by_code", lambda: {})
    monkeypatch.setattr(session_gate, "is_trading_day_now", lambda stamp: True)
    lifecycle.reset_for_tests()
    owner = CaptureProcessSession(buffer=LiveBuffer(), data_dir=tmp_path, process_target=fake_entry)
    try:
        await owner.sync(("005930",), n_accounts=1)
        await until(owner.fresh)
        assert owner.process.pid != os.getpid()
        assert (tmp_path / "child-imports").read_text() == "False"
        assert owner.status()["collector"]["display"]["dropped"] > 0
        assert owner.status()["collector"]["gc"]["enabled"]
        assert owner.display_gaps > 0
        assert await owner.on_view_subscribe("000660", {"KRX", "NXT"}, ref="tab")
        await owner.on_view_unsubscribe("000660", {"KRX"}, ref="tab")
        assert owner.views[("000660", "tab")] == {"NXT"}
        assert (await owner.refresh_vi("005930"))["test"]
        await owner.refresh_alert_settings()
        snapshot = await owner.seconds_snapshot("005930", "KRX", "20261002")
        assert snapshot["dates"] == ["20261002"]
        actual = tmp_path / "live_kiwoom" / "20261002" / "KRX" / "005930.jsonl"
        reference = tmp_path / "reference"
        ref = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(reference), date_fn=lambda: "20261002",
                         phase_fn=lambda: "regular", signal_monitor_fn=lambda: None)
        ref._open_venues = frozenset({"KRX"})
        await produce(ref)
        assert actual.read_text() == (reference / "20261002" / "KRX" / "005930.jsonl").read_text()
        # Freeze only this test parent's event loop. Child acknowledges its own
        # disk progress on a file while parent readers cannot run at all.
        (tmp_path / "trigger").touch()
        deadline = time.monotonic() + 15
        while not (tmp_path / "child-progress").exists() and time.monotonic() < deadline:
            time.sleep(0.01)
        assert (tmp_path / "child-progress").read_text() == "stored"
        pid, epoch = owner.process.pid, owner.epoch
        owner.process.terminate()
        await asyncio.to_thread(owner.process.join, 5)
        assert not owner.fresh()
        await owner.watchdog_pass(0)
        await until(owner.fresh)
        assert owner.process.pid != pid and owner.epoch != epoch
        assert owner.restarts == 1
        assert owner.views[("000660", "tab")] == {"NXT"}
    finally:
        await owner.stop()
    assert owner.process is None
    from hoga.api import ownership
    lock = ownership._try_acquire(tmp_path / ".live-capture.lock", retries=1, denied_message="test")
    assert lock is not None
    lock.release()


async def test_ipc_bounds_invalid_header_and_late_cancelled_reply():
    outbox = BoundedOutbox(max_messages=2, max_bytes=12)
    assert outbox.put(b"a" * 5) and outbox.put(b"b" * 5)
    assert outbox.put(b"c" * 5)
    assert list(outbox.frames) == [b"b" * 5, b"c" * 5]
    assert not outbox.put(b"z" * 13)
    assert outbox.bytes == 10 and outbox.dropped == 2
    reader = asyncio.StreamReader()
    reader.feed_data(struct.pack("!I", 100))
    with pytest.raises(ValueError, match="byte limit"):
        await read_frame(reader, limit=99)
    a, b = socket.socketpair()
    left, right = await open_channel(a), await open_channel(b)
    peer = RpcPeer(*left, "epoch")
    task = asyncio.create_task(peer.read())
    try:
        request = asyncio.create_task(peer.call("first"))
        first = await read_frame(right[0])
        request.cancel()
        await asyncio.gather(request, return_exceptions=True)
        next_request = asyncio.create_task(peer.call("second"))
        second = await read_frame(right[0])
        right[1].write(encode({"epoch": "epoch", "reply": first["id"], "result": "old"}))
        right[1].write(encode({"epoch": "epoch", "reply": second["id"], "result": "new"}))
        assert await next_request == "new"
        assert not peer.pending
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for _, writer in (left, right):
            writer.close()
            await writer.wait_closed()


async def test_forward_buffer_keeps_latest_book_when_display_frame_rejected():
    from hoga.live.snapshot import LiveSnapshot
    queue = BoundedOutbox(max_messages=1, max_bytes=64)
    buffer = ForwardBuffer("epoch", queue)
    book = {"asks": [{"price": 100, "qty": 1}], "bids": [], "venue": "KRX"}
    await buffer.publish("005930", [LiveSnapshot(STAMP, SnapshotKind.OB, book)])
    assert queue.dropped == 1
    assert (await buffer.last_ob_snapshot())[0][("005930", "KRX")]["asks"] == book["asks"]


async def test_cancelled_flush_finishes_storage_cycle(tmp_path):
    stream = LiveStream(buffer=LiveBuffer(), writer=LiveWriter(tmp_path), date_fn=lambda: "20261002")
    started, finish = asyncio.Event(), asyncio.Event()
    completed = []
    async def flush(**kwargs):
        started.set()
        await finish.wait()
        completed.append("saved")
    stream.flush_once = flush
    task = asyncio.create_task(stream._finish_flush())
    await started.wait()
    task.cancel()
    await asyncio.sleep(0)
    assert not task.done()
    finish.set()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert completed == ["saved"]


async def test_writer_fsync_covers_dirty_venue_files_without_rescanning(tmp_path, monkeypatch):
    from hoga.live.snapshot import LiveSnapshot
    writer = LiveWriter(tmp_path)
    synced = []
    monkeypatch.setattr(writer, "_fsync_one", synced.append)
    await writer.append("20261002", "005930", "NXT", [LiveSnapshot(1, SnapshotKind.OB, {})])
    await writer.fsync_all()
    await writer.fsync_all()
    assert synced == [tmp_path / "20261002" / "NXT" / "005930.jsonl"]


def test_seconds_http_uses_remote_pending_and_rejects_unavailable(tmp_path, monkeypatch):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from hoga.live import lifecycle
    from hoga.live.second_trade_api import build_router
    from hoga.live.second_trade_store import SecondTradeStore
    stamp = int(datetime.now(KST).replace(hour=10, minute=0, second=0, microsecond=0).timestamp() * 1000)
    date = datetime.fromtimestamp(stamp / 1000, KST).strftime("%Y%m%d")
    store = SecondTradeStore(tmp_path / "isolated-child-seconds")
    store._sealed_before = stamp - 60_000
    store.ingest(WsTick("005930", stamp, SnapshotKind.TRADE, {
        "trades": [{"t_ms": stamp, "price": 100, "qty": 7, "side": 1}],
    }))
    class Remote:
        unavailable = False
        async def seconds_snapshot(self, code, venue, day=None):
            if self.unavailable:
                raise ConnectionError("closed")
            return {"live": store.live_rows(code, venue, day or date), "pending": [],
                    "dates": [date], "error": "test_storage_error"}
    owner = Remote()
    monkeypatch.setattr(lifecycle, "get_capture_session", lambda: owner)
    app = FastAPI()
    app.include_router(build_router(data_dir=tmp_path))
    client = TestClient(app)
    url = f"/api/live/second-aggregates?code=005930&date={date}&seconds=1&include_prices=true"
    response = client.get(url)
    assert response.status_code == 200
    assert response.json()["bars"][0]["volume"] == 7
    assert response.json()["storage_error"] == "test_storage_error"
    assert client.get("/api/live/second-trade-dates?code=005930").json()["dates"] == [date]
    owner.unavailable = True
    assert client.get(url).status_code == 503


def test_deep_health_does_not_claim_healthy_for_failed_child(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from fastapi.testclient import TestClient

    from hoga.api import app as assembly
    from hoga.live.lifecycle import LiveStatus
    application = assembly.create_app(data_dir=tmp_path)
    application.state.startup_runtime = SimpleNamespace(supervised_task_health=lambda: [])
    monkeypatch.setattr(assembly._captures_module, "queue_ownership_state", lambda: {
        "ready": True, "owned": True, "disabled_by_env": False,
    })
    value = {"ready": False, "alive": False, "pid": 123, "storage_errors": []}
    monkeypatch.setattr(assembly, "live_get_status", lambda: LiveStatus(
        running=False, started_at_ms=None, last_tick_ms=None, cycle_lag_ms=0,
        watchlist_count=0, kiwoom={"collector": value}))
    client = TestClient(application)
    response = client.get("/health?deep=1")
    assert response.status_code == 503
    assert response.json()["collector"] == value
    assert response.json()["dead_tasks"] == []
    value["ready"] = True
    assert client.get("/health?deep=1").status_code == 200


async def test_storage_failure_keeps_connection_evidence_but_unhealthy(tmp_path, monkeypatch):
    owner = CaptureProcessSession(buffer=LiveBuffer(), data_dir=tmp_path)
    monkeypatch.setattr(owner, "fresh", lambda: True)
    monkeypatch.setattr(owner, "alive", lambda: True)
    owner._state = {"status": {"connected_accounts": 6}, "storage_errors": ["append_failed"]}
    result = owner.status()
    assert result["connected_accounts"] == 6
    assert not result["collector"]["ready"]


async def test_program_stop_waits_for_entire_drained_cycle(tmp_path):
    from hoga.live.program_trade_collector import ProgramTradeCollector
    collector = ProgramTradeCollector(data_dir=tmp_path, date_fn=lambda: "20261002", now_ms_fn=lambda: STAMP)
    started, finished = asyncio.Event(), asyncio.Event()
    calls = []
    async def cycle():
        started.set()
        await finished.wait()
        calls.append("whole batch stored")
    collector.run_once = cycle
    collector.start()
    await started.wait()
    stopping = asyncio.create_task(collector.stop())
    await asyncio.sleep(0)
    assert not stopping.done()
    finished.set()
    await stopping
    assert calls == ["whole batch stored"]


class OfflineSession(CaptureProcessSession):
    async def _configuration(self, targets, n_accounts):
        return {"targets": list(targets), "n_accounts": n_accounts, "nxt_map": {},
                "calendar_date": datetime.now(KST).strftime("%Y%m%d"), "calendar_allowed": True,
                "view_codes": [], "view_refs": [], "names": {c: c for c in targets}}


def orphan_parent(root):
    async def run():
        owner = OfflineSession(buffer=LiveBuffer(), data_dir=Path(root), process_target=fake_entry)
        await owner.sync(("005930",), n_accounts=1)
        await until(owner.fresh)
        Path(root, "orphan-child-pid").write_text(str(owner.process.pid))
        Path(root, "parent-ready").touch()
        await asyncio.Event().wait()
    asyncio.run(run())


async def test_parent_death_retires_orphan_before_capture_lock_reuse(tmp_path):
    import fcntl
    import multiprocessing
    import signal
    parent = multiprocessing.get_context("spawn").Process(target=orphan_parent, args=(str(tmp_path),))
    parent.start()
    child_pid = None
    descriptor = None
    try:
        await until(lambda: (tmp_path / "parent-ready").exists())
        child_pid = int((tmp_path / "orphan-child-pid").read_text())
        descriptor = os.open(tmp_path / ".live-capture.lock", os.O_RDWR)
        with pytest.raises(BlockingIOError):
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        parent.terminate()
        await asyncio.to_thread(parent.join, 5)
        assert not parent.is_alive()
        def released():
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return True
            except BlockingIOError:
                return False
        await until(released)
        # This kernel lock, not a stale PID file, permits replacement.
        assert (tmp_path / ".live-capture.lock").exists()
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent.is_alive():
            parent.terminate()
        await asyncio.to_thread(parent.join, 5)
        parent.close()
        if child_pid is not None:
            with contextlib.suppress(ProcessLookupError):
                os.kill(child_pid, signal.SIGTERM)


@pytest.mark.parametrize("hour,minute", [(7, 59), (8, 0), (9, 0), (15, 30), (16, 0), (18, 0), (20, 0)])
def test_child_venue_clock_matches_existing_calendar_gate(hour, minute, monkeypatch):
    from hoga.live import session_gate
    stamp = int(datetime(2026, 10, 2, hour, minute, tzinfo=KST).timestamp() * 1000)
    monkeypatch.setattr(session_gate, "is_trading_day_now", lambda stamp: True)
    assert session_gate.venue_capture_windows_for_day(stamp, True) == session_gate.venue_capture_windows(stamp)
    assert not session_gate.venue_capture_windows_for_day(stamp, False)


@pytest.mark.parametrize(("day", "hour", "calendar_allowed", "expected"), [
    (3, 18, True, False),   # Saturday, even with an optimistic calendar
    (2, 10, False, False),  # weekday holiday
    (2, 7, True, False),    # before the connection window
    (2, 20, True, False),   # after the connection window
    (2, 8, True, True),
    (2, 18, True, True),    # NXT hours
])
async def test_collector_manager_reports_same_connection_gate_as_ws(
    tmp_path, monkeypatch, day, hour, calendar_allowed, expected,
):
    from hoga.live import collector_worker
    from hoga.live.kiwoom_session import KiwoomSessionManager

    stamp = int(datetime(2026, 10, day, hour, tzinfo=KST).timestamp() * 1000)
    monkeypatch.setattr(collector_worker, "now_ms", lambda: stamp)

    def manager_factory(**kwargs):
        # Exercise production wiring without building sockets or storage streams.
        return KiwoomSessionManager(**kwargs, _build_conn=lambda *_: None)

    worker = collector_worker.CollectorWorker(tmp_path, "epoch", None, manager_factory=manager_factory)
    worker.config = {"calendar_date": f"202610{day:02}", "calendar_allowed": calendar_allowed, "nxt_map": {}}
    try:
        await worker.manager.sync(("005930",), n_accounts=1)
        assert worker.manager.status()["connection_allowed"] is expected
        assert worker.manager._gate_fn() is expected
    finally:
        await worker.manager.stop()


async def test_cancelled_view_command_reconciles_full_desired_refs(tmp_path, monkeypatch):
    from hoga.live.collector_worker import CollectorWorker
    class Peer:
        async def call(self, method, args):
            raise asyncio.CancelledError()
    owner = OfflineSession(buffer=LiveBuffer(), data_dir=tmp_path)
    owner.peer = Peer()
    monkeypatch.setattr(owner, "alive", lambda: True)
    with pytest.raises(asyncio.CancelledError):
        await owner.on_view_subscribe("000660", {"KRX"}, ref="lost-ack")
    assert owner.views[("000660", "lost-ack")] == {"KRX"}
    worker = CollectorWorker(tmp_path, "epoch", None, manager_factory=FakeManager)
    calls = []
    async def unsub(code, venues, *, ref):
        calls.append((code, venues, ref))
    worker.manager.on_view_unsubscribe = unsub
    worker.views[("000660", "closed-tab")] = {"KRX", "NXT"}
    config = await owner._configuration(("005930",), 1)
    config.update(version=1, view_codes=["000660"], view_refs=[
        {"code": "000660", "ref": "lost-ack", "venues": ["KRX"]},
    ])
    try:
        await worker.synchronize(config)
        assert calls == [("000660", {"KRX", "NXT"}, "closed-tab")]
        assert worker.views == {("000660", "lost-ack"): {"KRX"}}
    finally:
        await worker.manager.stop()
        from hoga.live.kiwoom_diagnostics import configure_failure_context
        configure_failure_context(None)
