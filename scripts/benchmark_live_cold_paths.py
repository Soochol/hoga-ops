"""Offline comparison of inventory serialization sharing and collector transport.

No vendor credentials, user files, servers, or browser profiles are accessed.
This isolates CPU/bytes, not end-to-end production request latency.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import json
import statistics
import time
from pathlib import Path

from pydantic import TypeAdapter

from hoga.api.models import StockDate
from hoga.api.stock_dates_snapshot import StockDatesSnapshot
from hoga.live.collector_ipc import PeakSnapshotDelta, encode


def inventory_rows():
    values = dict.fromkeys([
        "regular_session_open_ms", "regular_session_close_ms", "data_window_first_ms", "data_window_last_ms",
        "price_min", "price_max", "captured_at", "total_volume", "pages_collected", "file_size_bytes",
        "today_open", "today_high", "today_low", "today_close",
    ], 100)
    return [StockDate(code=str(100000 + i), date="20261019", name="Synthetic",
                      collection_complete=True, is_partial=False, **values) for i in range(5000)]


async def inventory_comparison():
    rows = inventory_rows()
    adapter = TypeAdapter(list[StockDate])
    results = []
    for shared in (False, True):
        for repeat in range(3):
            gate = asyncio.Semaphore(3)
            cache = StockDatesSnapshot()
            scans = 0

            async def load(gate=gate):
                nonlocal scans
                scans += 1
                async with gate:
                    return await asyncio.to_thread(adapter.dump_json, rows, by_alias=True)

            started, cpu = time.perf_counter(), time.process_time()
            requests = [cache.get(lambda: 1, load) if shared else load() for _ in range(32)]
            bodies = await asyncio.gather(*requests)
            results.append({"shared": shared, "repeat": repeat, "computations": scans,
                            "wall_ms": (time.perf_counter() - started) * 1000,
                            "cpu_ms": (time.process_time() - cpu) * 1000,
                            "response_bytes": len(bodies[0]), "equal_bodies": all(b == bodies[0] for b in bodies)})
    return {"requests": 32, "rows": len(rows), "worker_slots": 3,
            "scope": "real Pydantic response serialization; excludes filesystem traversal and process IPC",
            "runs": results}


def peak_snapshot():
    return {f"{100000 + i}:KRX": {side: {
        "coverage": "full", "traded_bar_peaks": [
            {"price": 10000 + n, "qty": n + 1, "t_ms": 1700000000000 + n * 60000} for n in range(150)
        ],
    } for side in ("ask", "bid")} for i in range(64)}


def transport_run(delta_enabled: bool):
    delta = PeakSnapshotDelta()
    peaks = peak_snapshot()
    current = {}
    total_bytes = 0
    durations = []
    for sequence in range(1, 31):
        # Equal-content fresh objects match real snapshot rebuilding. Keep the
        # builder outside the transport timer in both variants.
        values = copy.deepcopy(peaks)
        values["100000:KRX"]["ask"]["traded_bar_peaks"][-1]["qty"] = sequence
        state = {"epoch": "offline", "sequence": sequence, "desired_version": 1, "peaks": values}
        started = time.perf_counter()
        frame = encode(delta.apply(state, queued=False) if delta_enabled else state)
        decoded = json.loads(frame[4:])
        if decoded.get("peaks_full", True):
            current = decoded["peaks"]
        else:
            current.update(decoded["peaks"])
            for key in decoded["peaks_removed"]:
                current.pop(key, None)
        durations.append((time.perf_counter() - started) * 1000)
        total_bytes += len(frame)
        assert current == values
    return {"delta": delta_enabled, "bytes": total_bytes, "frames": len(durations),
            "transport_total_ms": sum(durations), "frame_median_ms": statistics.median(durations),
            "frame_max_ms": max(durations), "state_equivalent": True}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    report = {"inventory": await inventory_comparison(), "collector": {
        "codes": 64, "peak_rows_per_side": 150, "frames": 30, "changed_codes_per_frame": 1,
        "scope": "snapshot comparison + JSON encode/decode + parent replacement; excludes snapshot builder/socket time",
        "runs": [transport_run(enabled) for enabled in (False, True) for _ in range(3)],
    }}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(args.output)


if __name__ == "__main__":
    asyncio.run(main())
