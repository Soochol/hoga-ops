"""Spawn entry point for the sole Live Capture writer. No FastAPI app import.

The manager and existing downsampling/storage logic run unchanged here. Only
display fanout uses a lossy, bounded outbox; token issuance/REST stay in parent.
EOF or parent death stops old sockets/writes before releasing the capture lock.
"""
from __future__ import annotations

import asyncio
import contextlib
import gc
import logging
import os
import socket
import threading
import time
import weakref
from datetime import datetime
from pathlib import Path

from hoga.util.timeenc import KST

from .buffer import LiveBuffer
from .collector_ipc import DISPLAY_MAX_FRAME_BYTES, BoundedOutbox, RpcPeer, encode, open_channel
from .snapshot import SnapshotKind

log = logging.getLogger(__name__)


def today() -> str:
    return datetime.now(KST).strftime("%Y%m%d")


def now_ms() -> int:
    return int(time.time() * 1000)


class ForwardBuffer(LiveBuffer):
    """Keep latest orderbooks, not a second display history. Never wait on IPC."""
    def __init__(self, epoch: str, outbox: BoundedOutbox):
        super().__init__(max_total_entries=1, max_total_bytes=1)
        self.epoch, self.outbox = epoch, outbox
        self.sequence = 0
        self.desired_version = 0

    def forward(self, message: dict) -> None:
        self.sequence += 1
        try:
            frame = encode({**message, "epoch": self.epoch, "sequence": self.sequence,
                            "desired_version": self.desired_version}, limit=DISPLAY_MAX_FRAME_BYTES)
        except ValueError:
            self.outbox.dropped += 1
            return
        self.outbox.put(frame)

    async def publish(self, code, snapshots, *, now_ms=None):
        snapshots = list(snapshots)
        # The sidecar is small/compact and survives display IPC pressure.
        books = [s for s in snapshots if s.kind is SnapshotKind.OB]
        if books:
            await super().publish(code, books, now_ms=now_ms)
        self.forward({"type": "snapshots", "code": code, "now_ms": now_ms,
                      "snapshots": [{"t_ms": s.t_ms, "kind": s.kind.value, "payload": s.payload}
                                    for s in snapshots]})


class CollectorWorker:
    def __init__(self, root: Path, epoch: str, peer: RpcPeer, *, manager_factory=None):
        from .kiwoom_session import KiwoomSessionManager  # noqa: PLC0415 — child-only resources
        from .program_trade_collector import ProgramTradeCollector  # noqa: PLC0415
        from .signal_alert_monitor import SignalAlertMonitor  # noqa: PLC0415

        self.root, self.epoch, self.peer = root, epoch, peer
        self.display = BoundedOutbox()
        self.state_outbox = BoundedOutbox(max_messages=1)
        self.buffer = ForwardBuffer(epoch, self.display)
        self.config: dict = {}
        self.views: dict[tuple[str, str], set[str]] = {}
        self.peak_keys: set[tuple[str, str, str]] = set()
        self.peak_owners: dict[tuple[str, str, str], object] = {}
        self.state_sequence = 0
        self.monitor = SignalAlertMonitor(root, publish=lambda event: self.buffer.forward(
            {"type": "event", "event": event}))
        self.invalid_tokens: set[int] = set()
        self.manager = (manager_factory or KiwoomSessionManager)(
            buffer=self.buffer, data_dir=root, date_fn=today, now_fn=now_ms,
            nxt_map_fn=lambda: self.config.get("nxt_map"),
            gate_fn=lambda: self.day_allowed(now_ms()) and bool(self.open_clock(now_ms())),
            token_getter=self.token, token_invalidator=self.invalid_tokens.add,
            stream_options={"signal_monitor_fn": lambda: self.monitor,
                            "open_venues_fn": self.open_venues},
        )
        self.program = ProgramTradeCollector(data_dir=root, date_fn=today, now_ms_fn=now_ms,
                                             open_venues_fn=self.open_venues)
        self.started_at_ms = now_ms()
        self.last_ob_error = False
        self.ready = False
        self.stopping = asyncio.Event()

    def day_allowed(self, stamp: int) -> bool:
        day = datetime.fromtimestamp(stamp / 1000, KST)
        if day.weekday() >= 5:  # noqa: PLR2004 — weekend closed
            return False
        # Unknown calendar data for this day remains the parent's lenient
        # verdict. Across midnight wait for a current verdict instead of opening
        # a holiday connection based on yesterday's calendar (<= one sync pass).
        return (self.config.get("calendar_date") == day.strftime("%Y%m%d")
                and self.config.get("calendar_allowed", False))

    @staticmethod
    def open_clock(stamp: int) -> bool:
        from .session_gate import _within_connection_clock  # noqa: PLC0415 — shared pure clock
        return _within_connection_clock(stamp)

    async def open_venues(self, stamp: int) -> frozenset[str]:
        from .session_gate import venue_capture_windows_for_day  # noqa: PLC0415
        return venue_capture_windows_for_day(stamp, self.day_allowed(stamp))

    async def token(self, account: int) -> str:
        from .kiwoom_token_provider import KiwoomAuthTransient  # noqa: PLC0415
        invalid = account in self.invalid_tokens
        self.invalid_tokens.discard(account)
        try:
            return await self.peer.call("token", {"account": account, "invalidate": invalid})
        except (ConnectionError, TimeoutError) as exc:
            if invalid:
                self.invalid_tokens.add(account)
            raise KiwoomAuthTransient("collector token owner unavailable") from exc

    def peaks(self) -> dict:
        values = {}
        for code, venue, date in self.peak_keys:
            if date != today():
                continue
            for stream in self.manager.capture_streams():
                if stream.owns_code(code):
                    values[f"{code}:{venue}"] = {"ask": stream.ask_peak_snapshot(code, venue),
                                                "bid": stream.bid_peak_snapshot(code, venue)}
        return values

    async def seed_peak(self, args: dict) -> dict:
        from .stream import build_today_peak_seed  # noqa: PLC0415 — child-only replay
        code, venue, date = args["code"], args["venue"], args["date"]
        if date != today():
            return {}
        key = (code, venue, date)
        self.peak_keys = {k for k in self.peak_keys if k[2] == date}
        self.peak_owners = {k: owner for k, owner in self.peak_owners.items() if k in self.peak_keys}
        stream = next((s for s in self.manager.capture_streams() if s.owns_code(code)), None)
        if stream is None:
            return self.peaks()
        if (self.peak_owners[key]() if key in self.peak_owners else None) is not stream:
            if key not in self.peak_keys and len(self.peak_keys) >= 512:  # noqa: PLR2004 — finite query tracking
                raise ValueError("collector peak query capacity exceeded")
            seed = await asyncio.to_thread(build_today_peak_seed, code=code, venue=venue,
                                           date=date, live_root=self.root / "live_kiwoom")
            # Resolve ownership again after replay: a sync may have moved it.
            if stream in self.manager.capture_streams() and stream.owns_code(code):
                if seed is not None:
                    stream.install_today_peak_seed(code=code, venue=venue, seed=seed)
                self.peak_owners[key] = weakref.ref(stream)
            self.peak_keys.add(key)
        return self.peaks()

    async def synchronize(self, args: dict):
        from hoga.api.gc_probe import stats_snapshot  # noqa: PLC0415

        from .kiwoom_diagnostics import configure_failure_context  # noqa: PLC0415
        configure_failure_context(lambda: {
            "commit": self.config.get("commit"), "live_started_at_ms": self.config.get("live_started_at_ms"),
            "collector_epoch": self.epoch, "collector_started_at_ms": self.started_at_ms,
            "gc": stats_snapshot(),
        })
        version = args["version"]
        if version < self.buffer.desired_version:
            raise ValueError("old collector desired version")
        self.config = args
        self.buffer.desired_version = version
        self.monitor.set_targets(args.get("names", set(args["targets"])))
        await self.manager.sync(tuple(args["targets"]), n_accounts=args["n_accounts"])
        desired = {(v["code"], v["ref"]): set(v["venues"]) for v in args.get("view_refs", [])}
        for (code, ref), venues in self.views.items():
            removed = venues - desired.get((code, ref), set())
            if removed:
                await self.manager.on_view_unsubscribe(code, removed, ref=ref)
        self.views = {}
        for (code, ref), venues in desired.items():
            if await self.manager.on_view_subscribe(code, venues, ref=ref):
                self.views[(code, ref)] = venues
        await self.buffer.drop_codes_except(set(args["targets"]) | set(args.get("view_codes", [])))
        self.ready = True
        return {"version": version, "status": self.manager.status()}

    async def command(self, method: str, args: dict):
        if method == "sync":
            return await self.synchronize(args)
        if method == "view_subscribe":
            key = (args["code"], args["ref"])
            result = await self.manager.on_view_subscribe(key[0], set(args["venues"]), ref=key[1])
            if result:
                self.views[key] = self.views.get(key, set()) | set(args["venues"])
            return result
        if method == "view_unsubscribe":
            key = (args["code"], args["ref"])
            remaining = self.views.get(key, set()) - set(args["venues"])
            if remaining:
                self.views[key] = remaining
            else:
                self.views.pop(key, None)
            await self.manager.on_view_unsubscribe(args["code"], set(args["venues"]), ref=args["ref"])
            return None
        if method == "peaks":
            return {"values": await self.seed_peak(args), "state_sequence": self.state_sequence}
        if method == "seconds":
            from .second_trade_store import second_trade_store  # noqa: PLC0415
            store = second_trade_store(self.root)
            code, venue = args["code"], args["venue"]
            date = args.get("date", today())
            return {"live": store.live_rows(code, venue, date),
                    "pending": store.pending_corrections(code, venue, date),
                    "dates": sorted(store.live_dates(code, venue)), "error": store.storage_error}
        if method == "vi":
            return self.manager.vi_status(args["code"])
        if method == "alert_settings":
            self.monitor.refresh_settings()
            return None
        if method == "stop":
            self.stopping.set()
            return None
        raise ValueError("unknown collector method")

    async def commands(self) -> None:
        while not self.stopping.is_set():
            command = await self.peer.commands.get()
            try:
                result = await self.command(command["method"], command["args"])
                try:
                    await self.peer.reply(command, result=result)
                except ValueError:
                    await self.peer.reply(command, error="collector response exceeds byte limit")
            except Exception:
                log.exception("collector.command_failed method=%s", command.get("method"))
                await self.peer.reply(command, error="collector command failed")

    def state(self) -> dict:
        from hoga.api.gc_probe import stats_snapshot  # noqa: PLC0415 — recorder only, no app

        from .second_trade_store import second_trade_store  # noqa: PLC0415

        streams = self.manager.capture_streams()
        errors = ["last_ob_storage_error"] if self.last_ob_error else []
        errors += [s.storage_error for s in streams if s.storage_error]
        if second_trade_store(self.root).storage_error:
            errors.append("second_trade_storage_error")
        if self.program.status.last_error:
            errors.append("program_trade_storage_error")
        if self.program.task is not None and self.program.task.done():
            errors.append("program_trade_task_dead")
        self.state_sequence += 1
        return {"epoch": self.epoch, "sequence": self.state_sequence, "pid": os.getpid(),
                "started_at_ms": self.started_at_ms, "observed_at_ms": now_ms(),
                "desired_version": self.buffer.desired_version, "ready": self.ready,
                "status": self.manager.status(), "sector": self.manager.sector_snapshot(),
                "peaks": self.peaks(), "display": self.display.snapshot(), "gc": stats_snapshot(),
                "storage_errors": errors}

    async def states(self) -> None:
        while True:
            self.state_outbox.put(encode(self.state()))
            await asyncio.sleep(1)

    async def watchdog(self) -> None:
        while True:
            await self.manager.watchdog_pass(now_ms())
            self.monitor.refresh_settings()
            await asyncio.sleep(30)

    async def shutdown(self) -> None:
        # Socket owners stop first, then seal the remaining partial windows.
        streams = self.manager.capture_streams()
        await self.manager.stop()
        for stream in streams:
            await stream.flush_once(now_ms=now_ms(), seal_candle_venues=frozenset({"KRX", "NXT", "UN"}))
        await self.program.stop()
        await self.program.run_once()
        snapshot = await self.buffer.changed_last_ob_snapshot(None)
        if snapshot is not None:
            from .last_ob_store import save  # noqa: PLC0415
            entries, version = snapshot
            await asyncio.to_thread(save, self.root, entries, allow_empty=version[1] > 0)


def _parent_watch(parent_pid: int, loop: asyncio.AbstractEventLoop, stop: asyncio.Event) -> None:
    while os.getppid() == parent_pid:
        time.sleep(1)
    loop.call_soon_threadsafe(stop.set)
    # Bound orphan lifetime even if a storage syscall prevents graceful join.
    time.sleep(30)
    os._exit(1)


async def run_worker(root: str, epoch: str, sockets: tuple[socket.socket, ...], parent_pid: int,
                     *, manager_factory=None) -> None:
    from hoga.api import ownership  # noqa: PLC0415 — flock registry, no app
    from hoga.api.gc_probe import install, pause_warn_ms_from_env, uninstall  # noqa: PLC0415

    from .last_ob_runtime import start_flusher  # noqa: PLC0415

    root_path = Path(root)
    channels = [await open_channel(sock) for sock in sockets]
    peer = RpcPeer(*channels[0], epoch)
    worker = CollectorWorker(root_path, epoch, peer, manager_factory=manager_factory)
    threading.Thread(target=_parent_watch, args=(parent_pid, asyncio.get_running_loop(), worker.stopping),
                     daemon=True, name="collector-parent-watch").start()
    tasks = []
    flusher = None
    acquired = False
    from hoga.gc_tuning import GC_UPPER_GEN_THRESHOLDS, gc_gen0_threshold  # noqa: PLC0415
    threshold = gc_gen0_threshold()
    if threshold > 0:
        gc.set_threshold(threshold, *GC_UPPER_GEN_THRESHOLDS)
    install(warn_ms=pause_warn_ms_from_env())
    try:
        # Child-only lock survives parent release/crash until old writer exits.
        acquired = ownership.acquire("capture", root_path)
        if not acquired:
            raise RuntimeError("Live Capture owned by another process")
        from .last_ob_store import load  # noqa: PLC0415
        await worker.buffer.restore_last_ob(await asyncio.to_thread(load, root_path))
        worker.program.start()
        flusher = start_flusher(root_path, buffer_fn=lambda: worker.buffer,
                                error_fn=lambda failed: setattr(worker, "last_ob_error", failed))
        tasks = [asyncio.create_task(coro) for coro in (
            peer.read(), worker.commands(), worker.display.send(channels[1][1]),
            worker.state_outbox.send(channels[2][1]), worker.states(), worker.watchdog(),
        )]
        stop_task = asyncio.create_task(worker.stopping.wait())
        tasks.append(stop_task)
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            if task is not stop_task:
                task.result()  # IPC/worker failure remains an explicit failed exit
    finally:
        worker.ready = False
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if flusher is not None:
            flusher.cancel()
            await asyncio.gather(flusher, return_exceptions=True)
        if acquired:
            try:
                await worker.shutdown()
                # to_thread cancellation cannot stop an existing disk write.
            finally:
                await asyncio.get_running_loop().shutdown_default_executor()
                ownership.release("capture")
        for _, writer in channels:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
        uninstall()


def entry(root: str, epoch: str, sockets: tuple[socket.socket, ...], parent_pid: int) -> None:
    from logging.handlers import WatchedFileHandler  # noqa: PLC0415 — child-only logging

    from hoga.config import resolve_log_dir  # noqa: PLC0415 — lightweight path resolver

    fmt = "%(asctime)s %(levelname)s %(name)s [capture pid=%(process)d] %(message)s"
    logging.basicConfig(level=logging.INFO,
                        format=fmt)
    # Parent rotates; child follows the current file, as compute/promoter do.
    log_path = resolve_log_dir() / "hoga.log"
    if log_path.is_file():
        handler = WatchedFileHandler(log_path, encoding="utf-8")
        handler.setFormatter(logging.Formatter(fmt))
        logging.getLogger("hoga").addHandler(handler)
    asyncio.run(run_worker(root, epoch, sockets, parent_pid))
