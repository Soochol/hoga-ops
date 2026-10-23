"""Replay captured frames through real on_tick, stores and optional peak shadow.

Every measurement uses a fresh child process and a temporary data directory.
No API startup, credentials, vendor connections or production writes occur.
"""
from __future__ import annotations

import argparse
import asyncio
import gc
import hashlib
import json
import platform
import resource
import statistics
import subprocess
import sys
import tempfile
import time
import tracemalloc
import types
from collections import Counter
from pathlib import Path

from hoga.gc_tuning import GC_UPPER_GEN_THRESHOLDS, gc_gen0_threshold
from hoga.live.buffer import LiveBuffer
from hoga.live.peak_shadow import PeakShadow
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.snapshot import SnapshotKind
from hoga.live.stream import LiveStream
from hoga.live.ticks import WsTick
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST


def rss():
    for line in Path('/proc/self/status').read_text().splitlines():
        if line.startswith('VmRSS:'):
            return int(line.split()[1]) * 1024
    return 0


def legacy_stream(ref):
    for name, source in (("_shadow_original_peak", "ask_peak_state.py"), ("_shadow_original_stream", "stream.py")):
        module = types.ModuleType('hoga.live.' + name)
        module.__file__ = source
        sys.modules[module.__name__] = module
        text = subprocess.check_output(['git', 'show', f'{ref}:hoga/live/{source}']).decode()
        exec(compile(text, source, 'exec'), module.__dict__)  # noqa: S102 — trusted repository baseline
    original = sys.modules['hoga.live._shadow_original_peak']
    module.TodayAskPeakState, module.TodayBidPeakState = original.TodayAskPeakState, original.TodayBidPeakState
    return module.LiveStream


def load_ticks(path):
    ticks, counts = [], Counter()
    with path.open() as f:
        for line in f:
            row = json.loads(line)
            try:
                kind = SnapshotKind(row['kind'])
            except (ValueError, KeyError):
                continue
            payload = row.get('payload')
            if payload is None:
                payload = {k: v for k, v in row.items() if k not in ('code', 'kind', 't_ms')}
            venue = row.get('venue', payload.get('venue', 'KRX'))
            ticks.append(WsTick(row['code'], row['t_ms'], kind, payload, venue))
            counts[kind.value] += 1
    ticks.sort(key=lambda tick: tick.t_ms)
    return ticks, dict(counts)


def percentiles(values):
    ordered = sorted(values)
    return {name: ordered[min(len(ordered) - 1, int(len(ordered) * fraction))] / 1000
            for name, fraction in [('p50_us', .50), ('p95_us', .95), ('p99_us', .99), ('max_us', 1)]}


async def trial(args):
    ticks, counts = load_ticks(args.input)
    factory = legacy_stream(args.base) if args.mode == 'old' else LiveStream
    shadow = None if args.mode in ('old', 'off') else PeakShadow(max_sides=64, max_points=500_000,
                                                               max_side_points=100_000, max_check_ms=float('inf'))
    if args.memory:
        tracemalloc.start()
    gc_counts, gc_ns, gc_started = Counter(), Counter(), {}

    def observe_gc(phase, info):
        generation = info['generation']
        if phase == 'start':
            gc_started[generation] = time.perf_counter_ns()
        else:
            gc_counts[generation] += 1
            gc_ns[generation] += time.perf_counter_ns() - gc_started.pop(generation, time.perf_counter_ns())

    threshold = gc_gen0_threshold()
    if threshold > 0:
        gc.set_threshold(threshold, *GC_UPPER_GEN_THRESHOLDS)
    gc.callbacks.append(observe_gc)
    with tempfile.TemporaryDirectory(prefix='hoga-peak-shadow-') as directory:
        root = Path(directory)
        seconds = SecondTradeStore(root / 'seconds')
        # Historical replay has its own receive clock/sequence. Real constructors
        # start at wall time/time_ns, which would classify past rows as late and
        # make byte equality across otherwise identical runs non-deterministic.
        seconds._seq = 0
        seconds._sealed_before = ticks[0].t_ms - 600_000
        options = {} if args.mode == 'old' else {'peak_shadow': shadow}
        from datetime import datetime  # noqa: PLC0415 — runner wall dates follow replay timestamps
        day = [datetime.fromtimestamp(ticks[0].t_ms / 1000, KST).strftime('%Y%m%d')]
        owner = factory(buffer=LiveBuffer(max_total_entries=1024, max_total_bytes=4 * 1024 * 1024),
                        writer=LiveWriter(root / 'live'), date_fn=lambda: day[0], seconds=seconds,
                        phase_fn=lambda: 'regular', signal_monitor_fn=lambda: None, **options)
        owner._open_venues = frozenset({'KRX', 'NXT', 'UN'})
        owner.set_active_codes({tick.code for tick in ticks})
        before_rss = rss()
        latencies, batches = [], []
        next_flush = ticks[0].t_ms // 10_000 * 10_000 + 10_000
        begin = time.perf_counter()
        for index, tick in enumerate(ticks):
            if tick.t_ms >= next_flush:
                await owner.flush_once(now_ms=next_flush)
                next_flush = tick.t_ms // 10_000 * 10_000 + 10_000
            day[0] = datetime.fromtimestamp(tick.t_ms / 1000, KST).strftime('%Y%m%d')
            start = time.perf_counter_ns()
            await owner.on_tick(tick)
            latencies.append(time.perf_counter_ns() - start)
            if args.mode == 'shadow' and index % 128 == 0:
                start = time.perf_counter_ns()
                shadow.check_one()
                batches.append(time.perf_counter_ns() - start)
            if args.mode == 'strict':
                shadow.check_pair(owner, tick.code, tick.venue)
        replay_s = time.perf_counter() - begin
        rss_after_ingest = rss()
        if shadow is not None:
            for _ in range(len(shadow.entries)):
                shadow.check_one()
        await owner.flush_once(now_ms=next_flush, seal_candle_venues=frozenset({'KRX', 'NXT', 'UN'}))
        assert owner.storage_error is None and not seconds.storage_error
        peak_result = {f'{code}:{venue}': {'ask': owner.ask_peak_snapshot(code, venue),
                                         'bid': owner.bid_peak_snapshot(code, venue)}
                       for code, venue in sorted(owner._ask_peak_by_code.keys() | owner._bid_peak_by_code.keys())}
        digest = hashlib.sha256(json.dumps(peak_result, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        del peak_result
        files = {str(path.relative_to(root)): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in sorted(root.rglob('*.jsonl'))}
        state = None if shadow is None else shadow.summary()
        assert state is None or (not state['disabled'] and state.get('matched', 0) > 0), state
        memory = None
        if args.memory:
            current, peak = tracemalloc.get_traced_memory()
            memory = {'retained_bytes': current, 'peak_bytes': peak}
        owner.set_active_codes(set())
        if shadow is not None:
            assert shadow.points() == 0 and not shadow.entries
        if args.memory:
            memory['after_membership_release_bytes'] = tracemalloc.get_traced_memory()[0]
        final_rss = rss()
    gc.callbacks.remove(observe_gc)
    return {'mode': args.mode, 'input': str(args.input), 'rows': len(ticks), 'kinds': counts,
            'peak_digest': digest, 'durable_file_hashes': files,
            'on_tick': percentiles(latencies), 'on_tick_total_ms': sum(latencies) / 1_000_000,
            'replay_s_including_flush_and_checks': replay_s,
            'sampled_checks': None if not batches else percentiles(batches),
            'shadow': state, 'rss_before': before_rss, 'rss_after_ingest': rss_after_ingest,
            'rss_ingest_delta': rss_after_ingest - before_rss, 'rss_after_release': final_rss,
            'peak_rss': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
            'tracemalloc': memory, 'gc_counts': dict(gc_counts),
            'gc_ms': {str(k): v / 1_000_000 for k, v in gc_ns.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, action='append', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base', default='56ce0b5722b9d76112eb06c072cd7f6d45eba396')
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--mode', choices=['old', 'off', 'track', 'shadow', 'strict'])
    parser.add_argument('--memory', action='store_true')
    args = parser.parse_args()
    if args.mode:
        args.input = args.input[0]
        print(json.dumps(asyncio.run(trial(args))))
        return
    results = []
    modes = ['old', 'off', 'track', 'shadow']
    for source in args.input:
        for repeat in range(args.repetitions):
            for mode in modes[repeat % 4:] + modes[:repeat % 4]:
                command = [sys.executable, '-m', 'scripts.probe_peak_capture_shadow', '--input', str(source),
                           '--output', str(args.output), '--base', args.base, '--mode', mode]
                result = json.loads(subprocess.check_output(command))
                result['repeat'] = repeat
                results.append(result)
                # Preserve failed-trial evidence before any equality assertion.
                args.output.parent.mkdir(parents=True, exist_ok=True)
                args.output.with_suffix('.trials.json').write_text(json.dumps(results, indent=2) + '\n')
                print(source.name, repeat, mode, result['rows'], result['on_tick'], flush=True)
    for source in args.input:
        same = [result for result in results if result['input'] == str(source)]
        assert len({result['peak_digest'] for result in same}) == 1, 'native state mismatch'
        assert all(result['durable_file_hashes'] == same[0]['durable_file_hashes'] for result in same), \
            'storage mismatch'
    summary = {}
    for source in args.input:
        summary[source.name] = {}
        for mode in modes:
            selected = [r for r in results if r['input'] == str(source) and r['mode'] == mode]
            summary[source.name][mode] = {
                'median_on_tick': {key: statistics.median(r['on_tick'][key] for r in selected)
                                   for key in selected[0]['on_tick']},
                'median_on_tick_total_ms': statistics.median(r['on_tick_total_ms'] for r in selected),
                'median_rss_ingest_delta': statistics.median(r['rss_ingest_delta'] for r in selected),
                'median_replay_s': statistics.median(r['replay_s_including_flush_and_checks'] for r in selected)}
    inspected = ['hoga/live/ask_peak_state.py', 'hoga/live/stream.py', 'hoga/live/peak_changes.py',
                 'hoga/live/peak_shadow.py', 'hoga/live/collector_worker.py', __file__]
    report = {'base': args.base, 'python': platform.python_version(), 'platform': platform.platform(),
              'inputs': {str(path): {'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                   'bytes': path.stat().st_size} for path in args.input},
              'source_sha256': {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in inspected},
              'summary': summary, 'trials': results,
              'limits': ['Replay of captured API Live Ticks and stored snapshots, not a new vendor connection.',
                         'Shadow keeps legacy responses authoritative; new wire lane is not deployed.',
                         'Profiling explicitly raises diagnostic admission/time limits; runtime defaults stay bounded.',
                         'RSS is current process RSS without forced GC; peak RSS reported separately.',
                         'on_tick excludes flush/check cost; replay wall time includes both.',
                         'Input fixtures and writes are local; no production data changed.']}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    main()
