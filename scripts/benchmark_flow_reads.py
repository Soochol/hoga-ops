"""Offline flow payload benchmark. Never calls vendors or modifies source data.

uv run python scripts/benchmark_flow_reads.py --data-dir /path/to/data --date 20260910

Repeats captured rows to exercise parsing/serialization at 1x and 3x size; it is
not a replay of vendor changes. Cold cache and five simultaneous readers included.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import resource
import statistics
import time
from contextlib import suppress
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from hoga.api.market_routes import (
    DerivFlowResponse,
    InvestorFlowResponse,
    _deriv_flow_payload,
    _investor_flow_payload,
)
from hoga.live import flow_file_cache
from hoga.util.timeenc import KST


async def measure(root, fn, model, concurrency):
    lag = []

    async def heartbeat():
        while True:
            start = time.perf_counter()
            await asyncio.sleep(0.01)
            lag.append(max(0, (time.perf_counter() - start - 0.01) * 1000))

    def request():
        start = time.perf_counter()
        payload = model.model_validate(fn(root)).model_dump_json()
        return (time.perf_counter() - start) * 1000, len(payload)

    flow_file_cache._cache.clear()
    ticker = asyncio.create_task(heartbeat())
    cpu_start = time.process_time()
    results = []
    for _ in range(2):
        results.extend(await asyncio.gather(*(asyncio.to_thread(request) for _ in range(concurrency))))
    ticker.cancel()
    with suppress(asyncio.CancelledError):
        await ticker
    durations = [r[0] for r in results]
    return {
        "concurrent": concurrency, "requests": len(results),
        "p50_ms": round(statistics.median(durations), 1), "max_ms": round(max(durations), 1),
        "cpu_ms": round((time.process_time() - cpu_start) * 1000, 1),
        "heartbeat_max_lag_ms": round(max(lag, default=0), 1),
        "process_peak_rss_mib": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024, 1),
        "response_bytes": results[-1][1],
    }


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--date", required=True)
    args = parser.parse_args()
    now = dt.datetime.strptime(args.date, "%Y%m%d").replace(hour=15, tzinfo=KST)
    for scale in (1, 3):
        with TemporaryDirectory(prefix="flow-read-benchmark-") as folder:
            root = Path(folder)
            for kind in ("investor-flow", "deriv-flow"):
                relative = Path(kind) / "intraday" / f"{args.date}.jsonl"
                target = root / relative
                target.parent.mkdir(parents=True)
                target.write_bytes((args.data_dir / relative).read_bytes() * scale)
            # Isolate value reading costs from credentials, calendar and receipts.
            with patch("hoga.collector.orchestrator.now_kst", return_value=now), patch(
                "hoga.api.market_routes._flow_collection", return_value=None,
            ):
                for kind, fn, model in (
                    ("stock", _investor_flow_payload, InvestorFlowResponse),
                    ("deriv", _deriv_flow_payload, DerivFlowResponse),
                ):
                    for concurrent in (1, 5):
                        result = await measure(root, fn, model, concurrent)
                        print(json.dumps({"scale": scale, "kind": kind, **result}), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
