"""Repeated real on_tick/check/unsubscribe cycles with natural GC only."""
from __future__ import annotations

import argparse
import asyncio
import gc
import json
import tempfile
import tracemalloc
from collections import Counter
from pathlib import Path

from hoga.gc_tuning import GC_UPPER_GEN_THRESHOLDS, gc_gen0_threshold
from hoga.live.buffer import LiveBuffer
from hoga.live.peak_shadow import PeakShadow
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.writer import LiveWriter
from scripts.probe_peak_capture_shadow import load_ticks, rss


async def run(args):
    ticks, _ = load_ticks(args.input)
    tick = next(tick for tick in ticks if tick.kind is SnapshotKind.OB)
    gc.set_threshold(gc_gen0_threshold(), *GC_UPPER_GEN_THRESHOLDS)
    counts = Counter()

    def count_gc(phase, info):
        if phase == 'stop':
            counts[info['generation']] += 1

    gc.callbacks.append(count_gc)
    tracemalloc.start()
    samples = []
    with tempfile.TemporaryDirectory(prefix='hoga-shadow-lifetime-') as root:
        buffer = LiveBuffer(max_total_entries=1, max_total_bytes=1)
        shadow = PeakShadow(max_check_ms=float('inf'))
        owner = LiveStream(buffer=buffer, writer=LiveWriter(Path(root)), date_fn=lambda: '20261023',
                           phase_fn=lambda: 'regular', signal_monitor_fn=lambda: None, peak_shadow=shadow)
        for index in range(args.cycles):
            owner.set_active_codes({tick.code})
            await owner.on_tick(tick)
            shadow.check_pair(owner, tick.code, tick.venue)
            owner.set_active_codes(set())
            await buffer.drop_codes_except(set())
            assert not shadow.entries and not shadow.order and shadow.points() == 0
            assert not owner._ask_peak_by_code and not owner._bid_peak_by_code
            if (index + 1) % 100 == 0:
                retained, peak = tracemalloc.get_traced_memory()
                samples.append({'cycles': index + 1, 'retained_bytes': retained,
                                'peak_bytes': peak, 'rss': rss(), 'gc': dict(counts)})
        assert shadow.metrics['checks'] == args.cycles * 2
        assert shadow.metrics['mismatches'] == shadow.metrics['errors'] == 0
        result = {'cycles': args.cycles, 'samples': samples, 'shadow': shadow.summary(),
                  'gc': dict(counts), 'forced_gc': False}
    gc.callbacks.remove(count_gc)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--cycles', type=int, default=2000)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(asyncio.run(run(args)), indent=2) + '\n')


if __name__ == '__main__':
    main()
