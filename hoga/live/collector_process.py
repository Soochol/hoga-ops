"""API-side proxy for one spawned Live Capture owner (ADR-0174).

No vendor connections/writers live here. Restart only after confirmed exit;
stale state never implies permission to start a second writer. Default API
factory uses process mode; create_app/injected unit assemblies keep inprocess.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import multiprocessing
import os
import socket
import time
import uuid
from pathlib import Path

from .collector_ipc import DISPLAY_MAX_FRAME_BYTES, STATE_FRESH_S, RpcPeer, open_channel, read_frame
from .snapshot import LiveSnapshot, SnapshotKind

log = logging.getLogger(__name__)


class _Configuration:
    mode = "inprocess"
    publish = staticmethod(lambda event: None)


def configure_collector(mode: str, publish) -> None:
    if mode not in {"process", "inprocess"}:
        raise ValueError("HOGA_LIVE_COLLECTOR must be process or inprocess")
    _Configuration.mode, _Configuration.publish = mode, publish


def collector_mode() -> str:
    return _Configuration.mode


def _repository_commit() -> str | None:
    # Read checkout identity without importing the FastAPI assembly in the child.
    import subprocess  # noqa: PLC0415
    try:
        return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=Path(__file__).parents[2],
                                       stderr=subprocess.DEVNULL, timeout=2).decode().strip()
    except (OSError, subprocess.SubprocessError):
        return None


class CaptureProcessSession:
    def __init__(self, *, buffer, data_dir: Path, process_target=None):
        from .collector_worker import entry  # noqa: PLC0415 — spawn target has no app resources

        self.buffer, self.data_dir = buffer, data_dir
        self._target = process_target or entry
        self.commit = _repository_commit()
        self.process = None
        self.peer: RpcPeer | None = None
        self.tasks: list[asyncio.Task] = []
        self.epoch = ""
        self.version = 0
        self.ack_version = 0
        self.config: dict = {}
        self.views: dict[tuple[str, str], set[str]] = {}
        self._state: dict = {}
        self._received_at = 0.0
        self._state_sequence = 0
        self._display_sequence = 0
        self.display_gaps = 0
        self.discarded_old_frames = 0
        self.restarts = 0
        self.forced_terminations = 0
        self.next_start = 0.0
        self.error: str | None = None
        self.stopping = False
        self.lock = asyncio.Lock()
        self._peaks: dict = {}
        self._peak_sequence_floor = 0
        self._vi: dict = {}

    def alive(self) -> bool:
        return self.process is not None and self.process.is_alive()

    def fresh(self) -> bool:
        return (not self.stopping and self.alive() and self.peer is not None and not self.peer.closed.is_set()
                and time.monotonic() - self._received_at < STATE_FRESH_S
                and 0 <= int(time.time() * 1000) - self._state.get("observed_at_ms", 0) < STATE_FRESH_S * 1000
                and self.ack_version == self.version and self._state.get("desired_version") == self.version
                and self._state.get("ready", False) and not any(t.done() for t in self.tasks))

    async def _start(self) -> None:
        if self.alive():
            return
        # Reap an old child and all old epoch readers before spawning.
        await self._close_channels()
        if self.process is not None:
            await asyncio.to_thread(self.process.join)
            self.process.close()
            self.restarts += 1
        self.epoch = uuid.uuid4().hex
        self._state, self._peaks, self._vi = {}, {}, {}
        self._received_at = 0.0
        self._state_sequence = self._display_sequence = 0
        self._peak_sequence_floor = 0
        self.ack_version = 0
        pairs = [socket.socketpair() for _ in range(3)]
        proc = multiprocessing.get_context("spawn").Process(
            target=self._target, args=(str(self.data_dir), self.epoch, tuple(p[1] for p in pairs), os.getpid()),
            name="live-capture", daemon=True,
        )
        try:
            proc.start()
            self.process = proc
            channels = [await open_channel(pair[0]) for pair in pairs]
            self.peer = RpcPeer(*channels[0], self.epoch)
            self.tasks = [asyncio.create_task(coro, name=f"collector-{name}") for name, coro in (
                ("control", self.peer.read()), ("tokens", self._tokens(self.peer)),
                ("display", self._display(channels[1][0], self.epoch)),
                ("state", self._states(channels[2][0], self.epoch)),
            )]
            # Readers own these writers until explicit shutdown; otherwise GC
            # would close the receiving stream transport immediately.
            self._writers = [ch[1] for ch in channels]
            self.error = None
        except BaseException:
            for pair in pairs:
                for sock in pair:
                    sock.close()
            if proc.pid is not None and proc.is_alive():
                proc.terminate()
                await asyncio.to_thread(proc.join)
            raise
        finally:
            for _, sock in pairs:
                sock.close()

    async def _tokens(self, peer: RpcPeer) -> None:
        from .kiwoom_runtime import ensure_token_provider_for_account  # noqa: PLC0415

        while True:
            command = await peer.commands.get()
            if command.get("method") != "token":
                await peer.reply(command, error="unknown parent method")
                continue
            args = command["args"]
            # Never construct a token provider for an unsolicited account.
            if args["account"] not in range(self.config.get("n_accounts", 0)):
                await peer.reply(command, error="unconfigured token account")
                continue
            provider = ensure_token_provider_for_account(args["account"], self.data_dir)
            try:
                if provider is None:
                    raise ConnectionError("no token owner credentials")
                if args.get("invalidate"):
                    await asyncio.to_thread(provider.invalidate)
                token = await asyncio.to_thread(provider.get_token)
                await peer.reply(command, result=token)
            except Exception:  # noqa: BLE001 — redact token provider errors
                # Do not transport/log provider exceptions containing secrets.
                log.warning("collector.token_owner_unavailable account=%d", args["account"])
                await peer.reply(command, error="token owner unavailable")

    async def _display(self, reader: asyncio.StreamReader, epoch: str) -> None:
        while True:
            message = await read_frame(reader, limit=DISPLAY_MAX_FRAME_BYTES)
            if message.get("epoch") != epoch or epoch != self.epoch:
                raise ValueError("old collector display epoch")
            seq = message["sequence"]
            if seq <= self._display_sequence:
                raise ValueError("collector display sequence regression")
            gap = seq - self._display_sequence - 1
            self.display_gaps += gap
            self._display_sequence = seq
            if gap:
                await self.buffer.mark_delivery_gap(set(self.config.get("targets", [])) | {k[0] for k in self.views})
            if self.stopping or message.get("desired_version") != self.version:
                self.discarded_old_frames += 1
                if message.get("code"):
                    await self.buffer.mark_delivery_gap({message["code"]})
                continue
            if message["type"] == "snapshots":
                snapshots = [LiveSnapshot(s["t_ms"], SnapshotKind(s["kind"]), s["payload"])
                             for s in message["snapshots"]]
                await self.buffer.publish(message["code"], snapshots, now_ms=message["now_ms"])
            elif message["type"] == "event":
                _Configuration.publish(message["event"])

    async def _states(self, reader: asyncio.StreamReader, epoch: str) -> None:
        while True:
            state = await read_frame(reader)
            if state.get("epoch") != epoch or epoch != self.epoch:
                raise ValueError("old collector state epoch")
            if state["sequence"] <= self._state_sequence:
                raise ValueError("collector state sequence regression")
            self._state_sequence = state["sequence"]
            if state["desired_version"] != self.version:
                continue
            self._state = state
            if state["sequence"] > self._peak_sequence_floor:
                self._peaks = state["peaks"]
            self._received_at = time.monotonic()

    async def _configuration(self, targets, n_accounts) -> dict:
        from .kiwoom_session import _nxt_map  # noqa: PLC0415 — parent symbol/calendar SSOT
        from .lifecycle import _signal_alert_target_names, get_started_at_ms  # noqa: PLC0415 — parent watchlist names
        from .session_gate import is_trading_day_now  # noqa: PLC0415

        stamp = int(time.time() * 1000)
        from datetime import datetime  # noqa: PLC0415

        from hoga.util.timeenc import KST  # noqa: PLC0415

        return {"targets": list(targets), "n_accounts": n_accounts, "nxt_map": _nxt_map(),
                "calendar_date": datetime.fromtimestamp(stamp / 1000, KST).strftime("%Y%m%d"),
                "calendar_allowed": await asyncio.to_thread(is_trading_day_now, stamp),
                "view_codes": sorted({k[0] for k in self.views}),
                "view_refs": [{"code": code, "ref": ref, "venues": sorted(venues)}
                              for (code, ref), venues in sorted(self.views.items())],
                "names": _signal_alert_target_names(self.data_dir, set(targets)),
                "live_started_at_ms": get_started_at_ms(),
                "commit": self.commit}

    async def _sync_locked(self, kiwoom_targets, n_accounts) -> None:
        config = await self._configuration(kiwoom_targets, n_accounts)
        if (self.alive() and self.peer is not None and not self.peer.closed.is_set()
                and self.ack_version == self.version
                and config == {k: v for k, v in self.config.items() if k != "version"}):
            return
        self.stopping = False
        self.version += 1
        self.config = {**config, "version": self.version}
        await self._start()
        result = await self.peer.call("sync", self.config)
        if result["version"] != self.version:
            raise ConnectionError("collector desired ACK mismatch")
        self.ack_version = result["version"]
        for (code, ref), venues in self.views.items():
            await self.peer.call("view_subscribe", {"code": code, "ref": ref, "venues": sorted(venues)})

    async def sync(self, kiwoom_targets: tuple[str, ...], *, n_accounts: int) -> None:
        async with self.lock:
            await self._sync_locked(kiwoom_targets, n_accounts)

    async def watchdog_pass(self, now_ms: int) -> None:
        async with self.lock:
            if self.stopping or not self.config:
                return
            if self.alive() and any(task.done() for task in self.tasks):
                self.error = "collector_ipc_disconnected"
                await self._retire()
            if time.monotonic() < self.next_start:
                return
            try:
                await self._sync_locked(tuple(self.config["targets"]), self.config["n_accounts"])
                self.next_start = 0.0
            except Exception:
                self.error = "collector_recovery_failed"
                self.next_start = time.monotonic() + 30
                log.exception("collector.recovery_failed")

    async def on_view_subscribe(self, code: str, venues: set[str], *, ref: str) -> bool:
        async with self.lock:
            if len(self.views) >= 512 and (code, ref) not in self.views:  # noqa: PLR2004 — finite references
                return False
            previous = self.views.get((code, ref), set())
            self.views[(code, ref)] = previous | venues
            # If a reply is lost, retain desired state for reconciliation.
            if not self.alive() or self.peer is None:
                return True
            result = await self.peer.call("view_subscribe", {"code": code, "venues": sorted(venues), "ref": ref})
            if not result:
                if previous:
                    self.views[(code, ref)] = previous
                else:
                    self.views.pop((code, ref), None)
            return bool(result)

    async def on_view_unsubscribe(self, code: str, venues: set[str], *, ref: str) -> None:
        async with self.lock:
            # Remove desired ref even when the old child died; restart must not
            # resurrect a tab that has already closed.
            remaining = self.views.get((code, ref), set()) - venues
            if remaining:
                self.views[(code, ref)] = remaining
            else:
                self.views.pop((code, ref), None)
            if self.alive() and self.peer is not None and not self.peer.closed.is_set():
                await self.peer.call("view_unsubscribe", {"code": code, "venues": sorted(venues), "ref": ref})

    def capture_streams(self) -> list:
        return [self] if self.fresh() else []

    def owns_code(self, code: str) -> bool:
        return code in self.active_codes()

    def active_codes(self) -> list[str]:
        return self._state.get("status", {}).get("subscribed_codes", []) if self.fresh() else []

    def ask_peak_snapshot(self, code: str, venue: str):
        return self._peaks.get(f"{code}:{venue}", {}).get("ask") if self.fresh() else None

    def bid_peak_snapshot(self, code: str, venue: str):
        return self._peaks.get(f"{code}:{venue}", {}).get("bid") if self.fresh() else None

    async def ensure_today_peaks_seeded(self, code, venue, date) -> None:
        if not self.fresh():
            raise ConnectionError("collector state unavailable")
        result = await self.peer.call("peaks", {"code": code, "venue": venue, "date": date})
        self._peaks = result["values"]
        self._peak_sequence_floor = result["state_sequence"]

    async def seconds_snapshot(self, code, venue, date=None):
        if not self.fresh():
            raise ConnectionError("collector state unavailable")
        return await self.peer.call("seconds", {"code": code, "venue": venue, "date": date} if date else
                                    {"code": code, "venue": venue})

    def vi_status(self, code: str):
        # VI API is async and refreshes on demand; this is the last reply.
        return self._vi.get(code) if self.fresh() else None

    async def refresh_alert_settings(self) -> None:
        if self.alive() and self.peer is not None:
            await self.peer.call("alert_settings")

    async def refresh_vi(self, code: str):
        if not self.fresh():
            raise ConnectionError("collector state unavailable")
        result = await self.peer.call("vi", {"code": code})
        if len(self._vi) >= 512:  # noqa: PLR2004 — finite UI cache
            self._vi.pop(next(iter(self._vi)))
        self._vi[code] = result
        return result

    def sector_snapshot(self) -> dict:
        return self._state.get("sector", {}) if self.fresh() else {}

    def status(self) -> dict:
        status = dict(self._state.get("status", {}))
        ready = self.fresh() and not self._state.get("storage_errors")
        if not self.fresh():
            status.update(connected_accounts=0, subscribed_count=0, subscribed_codes=[], ready_codes=[],
                          ready_registrations=[], last_tick_ms=None, accounts=[], registration_incomplete=True)
        status.setdefault("connected_accounts", 0)
        status.setdefault("subscribed_count", 0)
        status.setdefault("subscribed_codes", [])
        status.setdefault("last_tick_ms", None)
        status.setdefault("accounts", [])
        status["collector"] = {"mode": "process", "epoch": self.epoch,
                               "pid": self.process.pid if self.process is not None else None,
                               "started_at_ms": self._state.get("started_at_ms"), "alive": self.alive(),
                               "ready": ready, "state_age_ms": int((time.monotonic() - self._received_at) * 1000)
                               if self._received_at else None,
                               "desired_version": self.version, "acked_version": self.ack_version,
                               "restarts": self.restarts, "forced_terminations": self.forced_terminations,
                               "error": self.error,
                               "storage_errors": self._state.get("storage_errors", []),
                               "display_gaps": self.display_gaps, "discarded_old_frames": self.discarded_old_frames,
                               "display": self._state.get("display", {}), "gc": self._state.get("gc", {})}
        return status

    async def _close_channels(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.tasks = []
        for writer in getattr(self, "_writers", []):
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
        self._writers = []
        self.peer = None

    async def _retire(self) -> None:
        if self.alive() and self.peer is not None and not self.peer.closed.is_set():
            with contextlib.suppress(ConnectionError, TimeoutError):
                await self.peer.call("stop")
        # Closing control also asks child to retire if the stop ACK was lost.
        await self._close_channels()
        if self.process is not None:
            await asyncio.to_thread(self.process.join, 30)
            if self.process.is_alive():
                self.error = "collector_shutdown_timeout"
                self.forced_terminations += 1
                self.process.terminate()
                await asyncio.to_thread(self.process.join, 5)
            if self.process.is_alive():
                raise RuntimeError("old collector exit unconfirmed; replacement forbidden")

    async def stop(self) -> None:
        async with self.lock:
            self.stopping = True
            await self._retire()
            if self.process is not None:
                self.process.close()
                self.process = None
