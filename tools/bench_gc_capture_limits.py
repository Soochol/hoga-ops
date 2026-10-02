"""Offline comparison of unchanged book reconstruction and bounded display retention.

Synthetic ten-level books, no vendor connection, server control or forced GC.
The legacy comparison is the unchanged flusher's previous read-before-version
algorithm on the same packed representation, not a full older-release replay.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import time
import tracemalloc
from pathlib import Path

from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind
from tools.bench_live_buffer import orderbook_payload

ENTRY_BUDGET = 4096
BYTE_BUDGET = 8 * 1024 * 1024


def current_rss_bytes() -> int:
    return int(Path("/proc/self/statm").read_text().split()[1]) * os.sysconf("SC_PAGE_SIZE")


async def benchmark(codes: int, ticks: int, iterations: int) -> dict:
    buffer = LiveBuffer()
    for index in range(codes):
        code = f"SYN{index:05d}"
        await buffer.publish(code, [LiveSnapshot(
            t_ms=1, kind=SnapshotKind.OB, payload=orderbook_payload(code, 0, 10),
        )], now_ms=1)
    expected, token = await buffer.changed_last_ob_snapshot(None)
    comparisons = {}
    for mode in ("read_before_version", "compare_before_read"):
        tracemalloc.start()
        start = time.perf_counter()
        for _ in range(iterations):
            if mode == "read_before_version":
                entries, _ = await buffer.last_ob_snapshot()
            else:
                assert await buffer.changed_last_ob_snapshot(token) is None
        elapsed = (time.perf_counter() - start) * 1000
        _, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        comparisons[mode] = {"elapsed_ms": elapsed, "traced_peak_bytes": peak}
        if mode == "read_before_version":
            assert entries == expected

    buffer = LiveBuffer(max_total_entries=ENTRY_BUDGET, max_total_bytes=BYTE_BUDGET)
    checkpoints = []
    tracemalloc.start()
    start = time.perf_counter()
    for tick in range(ticks):
        for index in range(codes):
            code = f"SYN{index:05d}"
            await buffer.publish(code, [LiveSnapshot(
                t_ms=1_000_000 + tick * 1000, kind=SnapshotKind.OB,
                payload=orderbook_payload(code, tick, 10),
            )], now_ms=1_000_000 + tick * 1000)
        if tick in {0, ticks // 4, ticks // 2, ticks * 3 // 4, ticks - 1}:
            stats = await buffer.stats_snapshot()
            current, peak = tracemalloc.get_traced_memory()
            checkpoints.append({
                "tick": tick, **stats, "traced_current_bytes": current,
                "traced_peak_bytes": peak, "rss_bytes": current_rss_bytes(),
            })
            assert stats["total_entries"] <= ENTRY_BUDGET
            assert stats["estimated_bytes"] <= BYTE_BUDGET
    tracemalloc.stop()
    assert len((await buffer.last_ob_snapshot())[0]) == codes
    return {
        "workload": {"codes": codes, "ticks": ticks, "levels": 10, "iterations": iterations},
        "unchanged_flush": comparisons,
        "bounded_display": {
            "elapsed_ms": (time.perf_counter() - start) * 1000,
            "checkpoints": checkpoints,
        },
        "limits": "Synthetic OB-only replay; size estimates exclude sidecar/allocator overhead. "
        "No claim about market peak load, natural gen2 or process isolation.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes", type=int, default=328)
    parser.add_argument("--ticks", type=int, default=100)
    parser.add_argument("--iterations", type=int, default=100)
    args = parser.parse_args()
    if min(args.codes, args.ticks, args.iterations) < 1:
        parser.error("all counts must be positive")
    print(json.dumps(asyncio.run(benchmark(args.codes, args.ticks, args.iterations)), indent=2))


if __name__ == "__main__":
    main()
