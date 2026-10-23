"""Live shadow using an existing app feed and already registered instruments.

No vendor authentication, new vendor sockets, production restart or data writes.
The old/new LiveStreams and their durable outputs live in a temporary directory.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import tempfile
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from urllib.request import urlopen

import websockets

from hoga.live.buffer import LiveBuffer
from hoga.live.peak_shadow import PeakShadow
from hoga.live.second_trade_store import SecondTradeStore
from hoga.live.session_gate import market_phase, venue_capture_windows_for_day
from hoga.live.stream import LiveStream, build_today_peak_seed
from hoga.live.writer import LiveWriter
from hoga.util.timeenc import KST
from scripts.probe_peak_capture_shadow import legacy_stream


def status(origin):
    with urlopen(origin + '/api/live/status', timeout=10) as response:
        return json.load(response)


async def run(args):
    initial = await asyncio.to_thread(status, args.origin)
    assert initial['capture_healthy'], 'Existing capture must already be healthy'
    registered = set(initial['kiwoom']['ready_registrations'])
    codes = [code for code in args.codes.split(',') if code in initial['kiwoom']['ready_codes'] and code in registered]
    assert codes, 'No already-registered codes; never create new vendor registrations for this probe'
    old_factory = legacy_stream(args.base)
    import sys  # noqa: PLC0415 — obtain matching original replay implementation
    old_seed_builder = sys.modules['hoga.live._shadow_original_stream'].build_today_peak_seed
    shadow = PeakShadow()  # Test actual runtime defaults, including point/time budgets.
    begin = time.time()
    date = datetime.now(KST).strftime('%Y%m%d')
    events, kinds, venues = Counter(), Counter(), Counter()
    rows, full_compares = 0, 0
    with tempfile.TemporaryDirectory(prefix='hoga-shadow-live-') as directory:
        root = Path(directory)
        seeds = []
        for code in codes:
            for venue, wire in [('KRX', code), ('NXT', code + '_NX'), ('UN', code + '_AL')]:
                source = args.data / 'live_kiwoom' / date / venue / (code + '.jsonl')
                if wire not in registered or not source.exists():
                    continue
                with source.open('rb') as capture:
                    payload = capture.read(source.stat().st_size)
                payload = payload[:payload.rfind(b'\n') + 1]
                target = root / 'seed' / date / venue / (code + '.jsonl')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload)
                seeds.append({'code': code, 'venue': venue, 'bytes': len(payload),
                              'sha256': hashlib.sha256(payload).hexdigest()})
        owners = []
        for label, factory in [('old', old_factory), ('new', LiveStream)]:
            seconds = SecondTradeStore(root / label / 'seconds')
            seconds._seq = 0
            options = {} if label == 'old' else {'peak_shadow': shadow}
            owner = factory(buffer=LiveBuffer(max_total_entries=1024, max_total_bytes=4 * 1024 * 1024),
                            writer=LiveWriter(root / label / 'live'), seconds=seconds,
                            date_fn=lambda: date, phase_fn=lambda: market_phase(int(time.time() * 1000)),
                            signal_monitor_fn=lambda: None, **options)
            owner.set_active_codes(set(codes))
            builder = old_seed_builder if label == 'old' else build_today_peak_seed
            for seed in seeds:
                value = await asyncio.to_thread(builder, code=seed['code'], venue=seed['venue'],
                                                date=date, live_root=root / 'seed')
                if value is not None:
                    owner.install_today_peak_seed(code=seed['code'], venue=seed['venue'], seed=value)
            owners.append(owner)
        shadow.reconcile([owners[1]])
        for _ in range(len(shadow.entries)):
            shadow.check_one()
        next_flush = int(time.time() * 1000) // 10_000 * 10_000 + 10_000
        url = args.origin.replace('http://', 'ws://').replace('https://', 'wss://') + '/api/ws'
        async with websockets.connect(url, max_size=8 * 1024 * 1024) as ws:
            for code in codes:
                await ws.send(json.dumps({'action': 'subscribe', 'code': code, 'venues': ['KRX']}))
            try:
                async with asyncio.timeout(args.seconds):
                    while True:
                        message = json.loads(await ws.recv())
                        if message.get('ch') == 'event':
                            events[message.get('data', {}).get('type', 'unknown')] += 1
                        if message.get('ch') != 'live' or message.get('code') not in codes:
                            continue
                        row = {'code': message['code'], **message['data']}
                        # Reuse exactly the same decoder as the frozen-capture replay.
                        from hoga.live.snapshot import SnapshotKind  # noqa: PLC0415
                        from hoga.live.ticks import WsTick  # noqa: PLC0415
                        payload = {k: v for k, v in row.items() if k not in ('code', 'kind', 't_ms')}
                        tick = WsTick(row['code'], row['t_ms'], SnapshotKind(row['kind']), payload,
                                      row.get('venue', 'KRX'))
                        stamp = int(time.time() * 1000)
                        for owner in owners:
                            owner._open_venues = venue_capture_windows_for_day(stamp, True)
                            await owner.on_tick(tick)
                        shadow.check_pair(owners[1], tick.code, tick.venue)
                        assert not shadow.disabled, shadow.summary()
                        for method in ('ask_peak_snapshot', 'bid_peak_snapshot'):
                            assert getattr(owners[0], method)(tick.code, tick.venue) == \
                                getattr(owners[1], method)(tick.code, tick.venue)
                            full_compares += 1
                        kinds[tick.kind.value] += 1
                        venues[tick.venue] += 1
                        rows += 1
                        if stamp >= next_flush:
                            for owner in owners:
                                await owner.flush_once(now_ms=next_flush)
                                await owner._writer.fsync_all()
                            next_flush = stamp // 10_000 * 10_000 + 10_000
            except TimeoutError:
                pass
            finally:
                for code in codes:
                    await ws.send(json.dumps({'action': 'unsubscribe', 'code': code}))
        for owner in owners:
            await owner.flush_once(now_ms=next_flush, seal_candle_venues=frozenset({'KRX', 'NXT', 'UN'}))
            await owner._writer.fsync_all()
            assert owner.storage_error is None and not owner._seconds.storage_error
        files = []
        for label in ('old', 'new'):
            files.append({str(path.relative_to(root / label)): hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in sorted((root / label).rglob('*.jsonl'))})
        assert files[0] == files[1], 'Live durable output differs'
        result = {'started_at_epoch': begin, 'elapsed_s': time.time() - begin, 'rows': rows,
                  'codes': codes, 'venues': dict(venues), 'kinds': dict(kinds), 'events': dict(events),
                  'full_oracle_comparisons': full_compares, 'shadow': shadow.summary(),
                  'seeds': seeds, 'durable_hashes': files[0], 'durable_equal': True,
                  'live_updates_observed': bool(rows and shadow.metrics['delta'])}
        for owner in owners:
            owner.set_active_codes(set())
        assert not shadow.entries and shadow.points() == 0
    final = await asyncio.to_thread(status, args.origin)
    result['production_capture_healthy_after'] = final['capture_healthy']
    result['production_connected_accounts_before_after'] = [initial['kiwoom']['connected_accounts'],
                                                            final['kiwoom']['connected_accounts']]
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--origin', default='http://127.0.0.1:8000')
    parser.add_argument('--data', type=Path, default=Path.home() / '.local/share/hoga-ops/data')
    parser.add_argument('--codes', default='003160,000660')
    parser.add_argument('--seconds', type=int, default=60)
    parser.add_argument('--base', default='56ce0b5722b9d76112eb06c072cd7f6d45eba396')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    result = asyncio.run(run(args))
    args.output.write_text(json.dumps(result, indent=2) + '\n')
    if not result['live_updates_observed']:
        raise SystemExit('Inconclusive sample: no peak updates observed; not counted as a live validation pass.')


if __name__ == '__main__':
    main()
