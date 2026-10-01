"""Offline buffered-input scheduling probe; no credentials or vendor connections.

Run: python -m tools.bench_kiwoom_consumer_budget --baseline-client /tmp/baseline.py
Prepare the baseline with git show <ref>:hoga/live/kiwoom_ws_client.py > /tmp/baseline.py.
The competing tasks deliberately saturate one loop. This is not production replay
or a measurement of exchange-to-client latency. Timing results are evidence, not CI assertions.
"""
from __future__ import annotations

import argparse
import asyncio
import importlib.util
import json
import logging
import sys
import time
from pathlib import Path

from hoga.live import kiwoom_ws_client
from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot

FRAME_COUNT = 240
MAX_SAMPLE_S = 3


def baseline_module(path: Path):
    name = "hoga.live._consumer_budget_baseline"
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


async def sample(module, *, rows: int, callback_suspends: bool, load_ms: float) -> dict:
    buffer = LiveBuffer()
    processed = 0

    async def consume(tick):
        nonlocal processed
        await buffer.publish(tick.code, [LiveSnapshot(t_ms=tick.t_ms, kind=tick.kind,
                                                     payload=tick.payload)])
        processed += 1
        if callback_suspends:
            await asyncio.sleep(0)

    row = {"type": "0D", "item": "005930", "values": {
        "21": "100000", **{str(f): "6500" for f in range(41, 61)},
        **{str(f): "10" for f in range(61, 81)}, "121": "100", "125": "200",
    }}
    raw = json.dumps({"trnm": "REAL", "data": [row] * rows})

    class Socket:
        received = 0

        async def recv(self):
            if self.received < FRAME_COUNT:
                self.received += 1
                return raw
            await asyncio.Event().wait()

    socket = Socket()
    client = module.KiwoomWsClient(token_fn=lambda: asyncio.sleep(0, result="unused"),
                                  on_tick=consume, date_fn=lambda: "20260616")

    async def competition():
        while True:
            end = time.perf_counter() + load_ms / 1000
            while time.perf_counter() < end:
                pass
            await asyncio.sleep(0)

    tasks = [asyncio.create_task(competition()) for _ in range(8)] if load_ms else []
    receiver = asyncio.create_task(client._recv_loop(socket))
    started = time.perf_counter()
    overflow = False
    try:
        while client.dispatch_latency.count < FRAME_COUNT and time.perf_counter() - started < MAX_SAMPLE_S:
            await asyncio.sleep(0.001)
            if receiver.done():
                try:
                    receiver.result()
                except module.KiwoomDataBacklogError:
                    overflow = True
                break
        # Capture before cancellation counts an in-flight frame as discarded.
        counts = client.data_queue_snapshot()
        completed = client._flow.completed_frames if getattr(client, "_flow", None) else None
        budgets = getattr(client, "_consumer_budget", None)
        return {
            "outcome": "overflow" if overflow else "complete" if processed == FRAME_COUNT * rows else "incomplete",
            "rows_per_frame": rows, "callback_suspends": callback_suspends,
            "competing_tasks": len(tasks), "cpu_ms_per_competing_turn": load_ms,
            "received_frames": socket.received, "dispatch_count": client.dispatch_latency.count,
            "completed_frames": completed, "processed_ticks": processed, "overflow": overflow,
            "queue": counts, "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
            "consumer_budget": budgets.snapshot() if budgets else None,
        }
    finally:
        for task in [receiver, *tasks]:
            task.cancel()
        await asyncio.gather(receiver, *tasks, return_exceptions=True)


async def main(args):
    baseline = baseline_module(args.baseline_client)
    results = []
    for repeat in range(args.repeats):
        for name, module in [("baseline", baseline), ("candidate", kiwoom_ws_client)]:
            for rows, suspend, load in [(4, False, 2), (16, False, 2), (4, True, 2),
                                        (16, True, 0)]:
                result = await sample(module, rows=rows, callback_suspends=suspend, load_ms=load)
                results.append({"version": name, "repeat": repeat, **result})
    print(json.dumps({"note": "240 already buffered frames, synthetic loop competition; offline",
                      "samples": results}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline-client", type=Path, required=True)
    parser.add_argument("--repeats", type=int, default=3)
    logging.disable(logging.WARNING)
    asyncio.run(main(parser.parse_args()))
