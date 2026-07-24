"""Deterministic, offline LiveBuffer soak benchmark."""

from __future__ import annotations

import argparse
import asyncio
import json
import resource
import time
import tracemalloc

from hoga.live.buffer import LiveBuffer
from hoga.live.snapshot import LiveSnapshot, SnapshotKind


def orderbook_payload(code: str, tick: int, levels: int) -> dict:
    base = 70_000 + tick % 100
    return {
        "code": code,
        "phase": "regular",
        "current_price": base,
        "asks": [
            {"price": base + level, "qty": 1_000 + tick + level}
            for level in range(1, levels + 1)
        ],
        "bids": [
            {"price": base - level, "qty": 1_200 + tick + level}
            for level in range(1, levels + 1)
        ],
        "total_ask_qty": 10_000 + tick,
        "total_bid_qty": 12_000 + tick,
    }


async def _publish_synthetic_ticks(
    *, codes: int, ticks_per_code: int, levels: int, retention_ms: int
) -> tuple[LiveBuffer, dict[str, object]]:
    buffer = LiveBuffer(retention_ms=retention_ms)
    base_t_ms = 1_000_000_000

    for code_index in range(codes):
        code = f"SYN{code_index:05d}"
        for tick in range(ticks_per_code):
            t_ms = base_t_ms + tick
            await buffer.publish(
                code,
                [
                    LiveSnapshot(
                        t_ms=t_ms,
                        kind=SnapshotKind.OB,
                        payload=orderbook_payload(code, tick, levels),
                    )
                ],
                now_ms=t_ms,
            )

    return buffer, await buffer.stats_snapshot()


def run_benchmark(
    *, codes: int, ticks_per_code: int, levels: int, retention_ms: int
) -> dict[str, int | float]:
    """Publish deterministic orderbook snapshots and return measurement results."""
    tracemalloc.start()
    started = time.perf_counter()
    _buffer, stats = asyncio.run(
        _publish_synthetic_ticks(
            codes=codes,
            ticks_per_code=ticks_per_code,
            levels=levels,
            retention_ms=retention_ms,
        )
    )
    elapsed_s = time.perf_counter() - started
    current_bytes, peak_bytes = tracemalloc.get_traced_memory()
    tracemalloc.stop()
    max_rss_bytes = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024
    published_total = int(stats["published_total"])

    return {
        "codes": codes,
        "ticks_per_code": ticks_per_code,
        "levels": levels,
        "retention_ms": retention_ms,
        "entries": int(stats["total_entries"]),
        "published_total": published_total,
        "high_water_entries": int(stats["high_water_entries"]),
        "subscriber_drops": int(stats["subscriber_drops"]),
        "buffer_codes": int(stats["codes"]),
        "max_entries_per_deque": int(stats["max_entries_per_deque"]),
        "elapsed_ms": elapsed_s * 1_000,
        "publishes_per_second": published_total / elapsed_s if elapsed_s else 0.0,
        "tracemalloc_current_bytes": current_bytes,
        "tracemalloc_peak_bytes": peak_bytes,
        "max_rss_bytes": max_rss_bytes,
    }


def _positive_int(value: str) -> int:
    parsed = int(value)
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Run a deterministic, offline LiveBuffer soak benchmark."
    )
    parser.add_argument("--codes", type=_positive_int, required=True)
    parser.add_argument("--ticks-per-code", type=_positive_int, required=True)
    parser.add_argument("--levels", type=_positive_int, required=True)
    parser.add_argument("--retention-ms", type=_positive_int, required=True)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    result = run_benchmark(
        codes=args.codes,
        ticks_per_code=args.ticks_per_code,
        levels=args.levels,
        retention_ms=args.retention_ms,
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
