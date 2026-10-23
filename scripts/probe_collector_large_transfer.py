"""Reproducible single-key IPC costs and actual capture/storage equivalence.

Each timing/memory trial runs in a fresh subprocess. The comparison baseline
permits the old monolithic encoder to exceed its production 8MiB limit solely
to measure its allocation/cost; the real old path raises instead.
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import multiprocessing
import platform
import socket
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
from collections import Counter
from datetime import datetime
from pathlib import Path

from hoga.gc_tuning import GC_UPPER_GEN_THRESHOLDS, gc_gen0_threshold
from hoga.live import collector_ipc as ipc
from hoga.live.ask_peak_state import Peak, TodayAskPeakState, TodayBidPeakState
from hoga.live.buffer import LiveBuffer
from hoga.live.collector_process import CaptureProcessSession
from hoga.live.collector_transfer import TRANSFER_FRAME_BYTES, write_frames
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST
from scripts.probe_peak_capture_shadow import legacy_stream, load_ticks, percentiles, rss

STAMP = int(datetime(2026, 10, 23, 10, tzinfo=KST).timestamp() * 1000)
BASE = "97b3ffe03fcefe7fb2e5ed6512d7d0356ec8ac65"


def state(peaks, sequence=1):
    return {"epoch": "probe", "sequence": sequence, "desired_version": 1, "peaks": peaks,
            "ready": True, "peaks_full": True, "observed_at_ms": int(time.time() * 1000)}


def native_message(points):
    sides = {}
    for name, cls in (("ask", TodayAskPeakState), ("bid", TodayBidPeakState)):
        native = cls()
        native.ingest_orderbook(t_ms=STAMP, **{"asks" if name == "ask" else "bids": [{"price": 100, "qty": 1}]})
        native.all_record = [Peak(100, 1_000_000 + i, STAMP + i) for i in range(points)]
        sides[name] = {"date": "20261023", **native.snapshot()}
    return state({"005930:KRX": sides})


class MeasuredWriter:
    def __init__(self, writer):
        self.writer = writer
        self.frames = self.bytes = self.max_frame = self.max_buffer = 0

    def write(self, frame):
        self.frames += 1
        self.bytes += len(frame)
        self.max_frame = max(self.max_frame, len(frame) - 4)
        self.writer.write(frame)
        self.max_buffer = max(self.max_buffer, self.writer.transport.get_write_buffer_size())

    async def drain(self):
        await self.writer.drain()


async def roundtrip(message, strategy):
    left, right = socket.socketpair()
    sender, receiver = await ipc.open_channel(left), await ipc.open_channel(right)
    writer = MeasuredWriter(sender[1])
    async def send():
        frames = (ipc.encode(message, limit=2**31),) if strategy == "monolithic" else ipc.state_frames(message)
        await write_frames(writer, frames)
    task = asyncio.create_task(send())
    try:
        result = await (ipc.read_frame(receiver[0], limit=2**31) if strategy == "monolithic"
                        else ipc.read_state(receiver[0]))
        await task
        return result, {k: v for k, v in vars(writer).items() if k != "writer"}
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        for _, channel in (sender, receiver):
            channel.close()
            await channel.wait_closed()


async def trial(args):
    message = native_message(args.points)
    old_error = None
    try:
        ipc.encode(message)
    except ValueError as exc:
        old_error = str(exc)
    gc_counts = Counter()
    def observe(phase, info):
        if phase == "stop":
            gc_counts[info["generation"]] += 1
    gc.callbacks.append(observe)
    before_rss = rss()
    if args.memory:
        tracemalloc.start()
    # Measure loop gaps as a separate probe of cooperative work, not vendor p99.
    gaps = []
    async def heartbeat():
        previous = time.perf_counter_ns()
        while True:
            await asyncio.sleep(0)
            now = time.perf_counter_ns()
            gaps.append(now - previous)
            previous = now
    task = asyncio.create_task(heartbeat())
    await asyncio.sleep(0)
    began, cpu = time.perf_counter(), time.process_time()
    result, transfer = await roundtrip(message, args.strategy)
    elapsed, cpu_ms = (time.perf_counter() - began) * 1000, (time.process_time() - cpu) * 1000
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)
    retained, peak = tracemalloc.get_traced_memory() if args.memory else (None, None)
    retained_rss = rss()
    assert result == message
    points_received = {side: len(result["peaks"]["005930:KRX"][side]["all_record_peaks"])
                       for side in ("ask", "bid")}
    result = None
    await asyncio.sleep(0)
    released = tracemalloc.get_traced_memory()[0] if args.memory else None
    if args.memory:
        tracemalloc.stop()
    gc.callbacks.remove(observe)
    return {"points_per_side": args.points, "strategy": args.strategy, "memory_profile": args.memory,
            "old_production_error": old_error, "matched": True, "points_received": points_received,
            "wall_ms": elapsed, "cpu_ms": cpu_ms, "loop_gaps": percentiles(gaps), "transfer": transfer,
            "rss_before": before_rss, "rss_retained": retained_rss, "rss_released": rss(),
            "traced_retained": retained, "traced_peak": peak, "traced_released": released,
            "natural_gc": dict(gc_counts), "forced_gc": False}


async def lifecycle():
    message = native_message(2000)
    tracemalloc.start()
    samples = []
    for index in range(100):
        result, _ = await roundtrip(message, "chunked")
        assert result == message
        result = None
        await asyncio.sleep(0)
        if (index + 1) % 10 == 0:
            current, peak = tracemalloc.get_traced_memory()
            samples.append({"cycle": index + 1, "retained": current, "peak": peak, "rss": rss()})
    tracemalloc.stop()
    return {"roundtrips": 100, "points_per_side": 2000, "matched": True, "samples": samples,
            "forced_gc": False}


def process_sender(sock, control, points, strategy):
    async def send():
        message = native_message(points)
        expected = hashlib.sha256(json.dumps(message, sort_keys=True).encode()).hexdigest()
        reader, channel = await ipc.open_channel(sock)
        writer = MeasuredWriter(channel)
        before_rss = rss()
        tracemalloc.start()
        frames = (ipc.encode(message, limit=2**31),) if strategy == "monolithic" else ipc.state_frames(message)
        await write_frames(writer, frames)
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        control.send({"expected_sha256": expected, "rss_before": before_rss, "rss_after": rss(),
                      "traced_retained": retained, "traced_peak": peak,
                      "transfer": {k: v for k, v in vars(writer).items() if k != "writer"}})
        await asyncio.to_thread(control.recv)  # Hold the source alive for parent RSS sampling.
        channel.close()
        await channel.wait_closed()
        control.close()
    asyncio.run(send())


async def processes(args):
    context = multiprocessing.get_context("spawn")
    left, right = socket.socketpair()
    parent_control, child_control = context.Pipe()
    child = context.Process(target=process_sender, args=(right, child_control, args.points, args.strategy))
    child.start()
    right.close()
    child_control.close()
    reader, channel = await ipc.open_channel(left)
    before_rss = rss()
    tracemalloc.start()
    try:
        message = await (ipc.read_frame(reader, limit=2**31) if args.strategy == "monolithic"
                         else ipc.read_state(reader))
        retained, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        parent_rss = rss()
        sender = await asyncio.to_thread(parent_control.recv)
        expected = sender.pop("expected_sha256")
        assert hashlib.sha256(json.dumps(message, sort_keys=True).encode()).hexdigest() == expected
        assert all(len(side["all_record_peaks"]) == args.points for side in message["peaks"]["005930:KRX"].values())
        parent_control.send("release")
        await asyncio.to_thread(child.join, 10)
        assert child.exitcode == 0
        return {"strategy": args.strategy, "points_per_side": args.points, "sha256": expected, "matched": True,
                "sender": sender, "parent": {"rss_before": before_rss, "rss_after": parent_rss,
                                             "traced_retained": retained, "traced_peak": peak},
                "forced_gc": False, "limits": "RSS includes imports/arenas; source tree constructed before tracing."}
    finally:
        if tracemalloc.is_tracing():
            tracemalloc.stop()
        if child.is_alive():
            parent_control.send("release")
            await asyncio.to_thread(child.join, 10)
        channel.close()
        await channel.wait_closed()
        parent_control.close()


def peaks(owner):
    return {f"{code}:{venue}": {"ask": owner.ask_peak_snapshot(code, venue),
                               "bid": owner.bid_peak_snapshot(code, venue)}
            for code, venue in sorted(owner._ask_peak_by_code.keys() | owner._bid_peak_by_code.keys())}


async def capture(args):
    old = legacy_stream(BASE)
    with tempfile.TemporaryDirectory(prefix="hoga-large-capture-") as directory:
        root = Path(directory)
        owners = []
        for name, cls in (("old", old), ("new", LiveStream)):
            seconds = SecondTradeStore(root / name / "seconds")
            seconds._seq, seconds._sealed_before = 0, STAMP - 600_000
            owner = cls(buffer=LiveBuffer(max_total_entries=1, max_total_bytes=1),
                        writer=LiveWriter(root / name / "live"), seconds=seconds,
                        date_fn=lambda: "20261023", phase_fn=lambda: "regular", signal_monitor_fn=lambda: None)
            owner._open_venues = frozenset({"KRX", "NXT", "UN"})
            owners.append(owner)
        timings = [[], []]
        async def ingest(tick, index):
            order = (0, 1) if index % 2 else (1, 0)
            for position in order:
                began = time.process_time_ns()
                await owners[position].on_tick(tick)
                timings[position].append(time.process_time_ns() - began)
        # Every retained record is produced by on_tick. Large synthetic input is
        # explicitly separate from the frozen actually observed API sample.
        for index in range(args.points):
            tick = WsTick("005930", STAMP + index, SnapshotKind.OB,
                          {"asks": [{"price": 101, "qty": 1_000_000 + index},
                                    *[{"price": 102 + level, "qty": 1} for level in range(3)]],
                           "bids": [{"price": 100, "qty": 1_000_000 + index},
                                    *[{"price": 99 - level, "qty": 1} for level in range(3)]]}, "KRX")
            await ingest(tick, index)
        snapshot_begin = time.perf_counter()
        initial = state(peaks(owners[1]))
        initial_snapshot_ms = (time.perf_counter() - snapshot_begin) * 1000
        assert all(len(initial["peaks"]["005930:KRX"][side]["all_record_peaks"]) == args.points
                   for side in ("ask", "bid"))
        with_error = None
        try:
            ipc.encode(initial)
        except ValueError as exc:
            with_error = str(exc)
        assert with_error is not None
        outbox = ipc.LatestStateOutbox()
        delta = ipc.PeakSnapshotDelta()
        outbox.put(delta.apply(initial, queued=False))
        left, right = socket.socketpair()
        sender, receiver = await ipc.open_channel(left), await ipc.open_channel(right)
        receiver[1].transport.pause_reading()
        writer = MeasuredWriter(sender[1])
        send = asyncio.create_task(outbox.send(writer))
        session = CaptureProcessSession(buffer=None, data_dir=root)
        session.epoch, session.version = "probe", 1
        receive = None
        try:
            async with asyncio.timeout(30):
                while sender[1].transport.get_write_buffer_size() <= TRANSFER_FRAME_BYTES:
                    await asyncio.sleep(0)
            ticks, counts = load_ticks(args.input)
            # Freeze an intermediate pending state, then replace it while the
            # first transaction is genuinely blocked on a stopped receiver.
            middle = len(ticks) // 2
            for index, tick in enumerate(ticks):
                if index == middle:
                    outbox.put(delta.apply(state(peaks(owners[1]), 2), queued=bool(outbox.frames)))
                await ingest(tick, index)
                if index % 1000 == 0:
                    for owner in owners:
                        await owner.flush_once(now_ms=tick.t_ms)
            snapshot_begin = time.perf_counter()
            current = peaks(owners[1])
            final_snapshot_ms = (time.perf_counter() - snapshot_begin) * 1000
            final_state = state(current, 3)
            outbox.put(delta.apply(final_state, queued=bool(outbox.frames)))
            assert outbox.frames[0]["peaks_full"] and not send.done()
            recovery_begin = time.perf_counter()
            receiver[1].transport.resume_reading()
            receive = asyncio.create_task(session._states(receiver[0], "probe"))
            async with asyncio.timeout(30):
                while session._state_sequence < final_state["sequence"]:
                    await asyncio.sleep(0)
            assert session._peaks == current == peaks(owners[0])
            recovery_ms = (time.perf_counter() - recovery_begin) * 1000
            for owner in owners:
                await owner.flush_once(now_ms=max(tick.t_ms for tick in ticks) + 60_000)
                await owner._writer.fsync_all()
            files = {}
            for path in (root / "old").rglob("*.jsonl"):
                relative = path.relative_to(root / "old")
                content = path.read_bytes()
                assert content == (root / "new" / relative).read_bytes()
                files[str(relative)] = {"bytes": len(content), "sha256": hashlib.sha256(content).hexdigest()}
            assert files
            return {"synthetic_ob_callbacks": args.points, "observed_callbacks": len(ticks), "kinds": counts,
                    "input_sha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
                    "native_and_parent_matched": True, "old_production_error": with_error,
                    "parent_final_sequence": session._state_sequence, "queue_overwrite_full_recovery": True,
                    "initial_snapshot_build_ms": initial_snapshot_ms, "final_snapshot_build_ms": final_snapshot_ms,
                    "resume_to_final_parent_ms": recovery_ms,
                    "blocked_native_ingestion_and_fsync_continued": True, "durable_files": files,
                    "callback_cpu": {mode: {**percentiles(samples), "total_ms": sum(samples) / 1_000_000}
                                     for mode, samples in zip(("old", "new"), timings, strict=True)},
                    "transfer": {k: v for k, v in vars(writer).items() if k != "writer"}}
        finally:
            for task in (send, receive):
                if task is not None:
                    task.cancel()
            await asyncio.gather(*(task for task in (send, receive) if task is not None), return_exceptions=True)
            for _, channel in (sender, receiver):
                channel.close()
                await channel.wait_closed()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--input", type=Path, default=Path("/tmp/hoga-peak-shadow-20261023/live.jsonl"))
    parser.add_argument("--trial", choices=("transport", "capture", "lifecycle", "processes"))
    parser.add_argument("--strategy", choices=("monolithic", "chunked"), default="chunked")
    parser.add_argument("--points", type=int, default=90_000)
    parser.add_argument("--memory", action="store_true")
    parser.add_argument("--repetitions", type=int, default=3)
    args = parser.parse_args()
    gc.set_threshold(gc_gen0_threshold(), *GC_UPPER_GEN_THRESHOLDS)
    if args.trial:
        run = {"capture": lambda: capture(args), "lifecycle": lifecycle, "processes": lambda: processes(args),
               "transport": lambda: trial(args)}
        result = asyncio.run(run[args.trial]())
        if args.output:
            args.output.write_text(json.dumps(result, indent=2) + "\n")
        else:
            print(json.dumps(result))
        return
    trials = []
    for points in (390, 90_000, 200_000):
        for strategy in ("monolithic", "chunked"):
            for repetition in range(args.repetitions + 1):
                command = [sys.executable, "-m", "scripts.probe_collector_large_transfer", "--trial",
                           "transport", "--points", str(points),
                           "--strategy", strategy]
                if repetition == args.repetitions:
                    command.append("--memory")
                trials.append(json.loads(subprocess.check_output(command)))
                print(f"completed points={points} strategy={strategy} trial={repetition}", file=sys.stderr)
    aggregates = []
    for points in (390, 90_000, 200_000):
        for strategy in ("monolithic", "chunked"):
            selected = [r for r in trials if r["points_per_side"] == points and r["strategy"] == strategy
                        and not r["memory_profile"]]
            aggregates.append({"points": points, "strategy": strategy,
                               **{key: statistics.median(r[key] for r in selected) for key in ("cpu_ms", "wall_ms")}})
    result = {"base": BASE, "python": platform.python_version(), "trials": trials,
              "medians": aggregates, "forced_gc": False,
              "limits": ("Both socket endpoints share one process. Traced timings excluded from CPU comparison; "
                         "RSS includes allocator arenas. The monolithic baseline bypasses only the frame "
                         "limit for measurement, and cannot serve these large histories in production.")}
    args.output.write_text(json.dumps(result, indent=2) + "\n")


if __name__ == "__main__":
    main()
