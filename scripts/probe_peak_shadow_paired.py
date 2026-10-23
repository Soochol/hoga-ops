"""Balanced per-callback CPU comparison under the same instantaneous host load."""
from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import platform
import tempfile
import time
from pathlib import Path

from hoga.gc_tuning import GC_UPPER_GEN_THRESHOLDS, gc_gen0_threshold
from hoga.live.buffer import LiveBuffer
from hoga.live.peak_shadow import PeakShadow
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.stream import LiveStream
from hoga.live.writer import LiveWriter
from scripts.probe_peak_capture_shadow import legacy_stream, load_ticks, percentiles


async def run(args):
    ticks, _ = load_ticks(args.input)
    old = legacy_stream(args.base)
    shadow = PeakShadow(max_sides=64, max_side_points=100_000, max_points=500_000, max_check_ms=float('inf'))
    threshold = gc_gen0_threshold()
    if threshold > 0:
        gc.set_threshold(threshold, *GC_UPPER_GEN_THRESHOLDS)
    with tempfile.TemporaryDirectory(prefix='hoga-paired-shadow-') as name:
        owners, samples = {}, {}
        modes = ['old', 'off', 'track']
        for mode in modes:
            root = Path(name) / mode
            seconds = SecondTradeStore(root / 'seconds')
            seconds._seq, seconds._sealed_before = 0, ticks[0].t_ms - 600_000
            options = {} if mode == 'old' else {'peak_shadow': shadow if mode == 'track' else None}
            owner = (old if mode == 'old' else LiveStream)(
                buffer=LiveBuffer(max_total_entries=1024, max_total_bytes=4 * 1024 * 1024),
                writer=LiveWriter(root / 'live'), seconds=seconds, date_fn=lambda: '20261023',
                phase_fn=lambda: 'regular', signal_monitor_fn=lambda: None, **options)
            owner._open_venues = frozenset({'KRX', 'NXT', 'UN'})
            owner.set_active_codes({tick.code for tick in ticks})
            owners[mode], samples[mode] = owner, []
        next_flush = ticks[0].t_ms // 10_000 * 10_000 + 10_000
        for index, tick in enumerate(ticks):
            if tick.t_ms >= next_flush:
                for owner in owners.values():
                    await owner.flush_once(now_ms=next_flush)
                next_flush = tick.t_ms // 10_000 * 10_000 + 10_000
            offset = index % len(modes)
            for mode in modes[offset:] + modes[:offset]:
                start = time.process_time_ns()
                await owners[mode].on_tick(tick)
                samples[mode].append(time.process_time_ns() - start)
        for _ in range(len(shadow.entries)):
            shadow.check_one()
        assert not shadow.disabled and shadow.metrics['mismatches'] == 0
        hashes = {}
        for mode, owner in owners.items():
            value = {f'{code}:{venue}': [owner.ask_peak_snapshot(code, venue), owner.bid_peak_snapshot(code, venue)]
                     for code, venue in sorted(owner._ask_peak_by_code.keys() | owner._bid_peak_by_code.keys())}
            hashes[mode] = hashlib.sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
        assert len(set(hashes.values())) == 1
        return {'input_sha256': hashlib.sha256(args.input.read_bytes()).hexdigest(), 'rows': len(ticks),
                'python': platform.python_version(), 'base': args.base, 'peak_hashes': hashes,
                'per_callback_cpu': {mode: {**percentiles(values), 'total_ms': sum(values) / 1_000_000}
                                     for mode, values in samples.items()},
                'shadow_final': shadow.summary(),
                'limitations': 'Rotating same-process order controls host load; shared GC and cache effects remain.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base', default='56ce0b5722b9d76112eb06c072cd7f6d45eba396')
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(asyncio.run(run(args)), indent=2) + '\n')


if __name__ == '__main__':
    main()
