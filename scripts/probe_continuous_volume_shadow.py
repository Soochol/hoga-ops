"""Shadow the existing app's subscribed KRX trades; never authenticate to a broker.

Uses existing HTTP/WS interfaces, a separate local volume IPC lane, and the new
memory runtime. No server, saved conditions, production files or tokens change.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
import hashlib
import json
import socket
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlencode
from urllib.request import urlopen

import websockets

from hoga.api.models import ScanRequest
from hoga.api.screener_bar_volume import MinuteSnapshot, VolumeBar
from hoga.api.screener_continuous import ContinuousAdapter, ContinuousMonitors
from hoga.live.collector_ipc import BoundedOutbox, encode, open_channel, read_frame
from hoga.live.volume_state import MINUTE, VolumeReplica, VolumeSource
from hoga.util.timeenc import KST


def read(origin, path):
    with urlopen(origin + path, timeout=30) as response:
        return json.load(response)


async def validate(args):
    def now():
        return int(time.time() * 1000)
    initial_status = await asyncio.to_thread(read, args.origin, '/api/live/status')
    watch, heat = await asyncio.gather(*[asyncio.to_thread(read, args.origin, path)
                                      for path in ['/api/watchlist', '/api/heatmap']])
    requested = {entry['code'] for doc in [watch, heat] for entry in doc['entries']}
    ready = set(initial_status['kiwoom']['ready_codes'])
    candidates = sorted(requested & ready)
    sample = ['005930', '000660', '006400', '035420', '012450', '373220', '005490', '011200']
    codes = [code for code in sample if code in candidates]
    inspected = ['hoga/live/volume_state.py', 'hoga/api/screener_continuous.py',
                 'hoga/live/collector_worker.py', 'hoga/live/collector_process.py']
    initial_hashes = {p: hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in inspected}
    epoch = 'shadow-' + str(now())
    source, replica = VolumeSource(epoch), VolumeReplica()
    source.configure(codes)
    replica.reset(epoch)
    outbox = BoundedOutbox()
    clock_start = now()
    metrics = Counter()
    compare = []
    seed_seconds = []
    event_latencies = []
    health = initial_status
    jobs = []
    socket_left, socket_right = socket.socketpair()
    incoming, outgoing = await open_channel(socket_left), await open_channel(socket_right)
    api_sem = asyncio.Semaphore(2)

    def generations(status):
        accounts = status['kiwoom'].get('accounts', [])
        signature = repr([(a['account_id'], a.get('connection_generation')) for a in accounts])
        return dict.fromkeys(set(status['kiwoom']['ready_codes']) & requested, signature)

    source.health(generations(health), now())

    async def receive_states():
        while True:
            frame = await read_frame(incoming[0])
            replica.apply(frame)
            event_latencies.append(max(0, now() - frame['observed_ms']))

    async def frames():
        while True:
            stamp = now()
            source.health(generations(health), stamp)
            for frame in source.frames(stamp):
                outbox.put(encode(frame))
            await asyncio.sleep(0.25)

    async def loader(data_dir, code, timeframe, needed, lower, as_of):
        async with api_sem:
            began = time.perf_counter()
            current = datetime.now(KST)
            # Two calendar days cover the requested window for ordinary stocks.
            # Friday/Monday is handled by the preceding weekday rather than a
            # fixed yesterday. Missing history remains visible, never invented.
            previous = current.date()
            from datetime import timedelta  # noqa: PLC0415 — CLI date bound
            previous -= timedelta(days=1)
            while previous.weekday() >= 5:  # noqa: PLR2004 — weekend
                previous -= timedelta(days=1)
            query = urlencode(dict(code=code, venue='KRX', **{'from': previous.strftime('%Y%m%d'),
                                                           'to': current.strftime('%Y%m%d')}))
            data = await asyncio.to_thread(read, args.origin, '/api/live/past-candles?' + query)
            stamp = now()
            values = []
            latest = max((row['t_ms'] for row in data['candles']), default=0)
            for row in data['candles']:
                clock = datetime.fromtimestamp(row['t_ms'] / 1000, KST)
                if 900 <= clock.hour * 100 + clock.minute <= 1530:  # noqa: PLR2004 — KRX regular
                    values.append(VolumeBar(row['t_ms'], int(row['volume']),
                        row['t_ms'] == latest or row['t_ms'] + MINUTE > stamp))
            metrics['history_http_requests'] += 1
            seed_seconds.append(time.perf_counter() - began)
            return MinuteSnapshot(values, stamp)

    async def targets(_codes):
        return None  # Already configured from production's existing subscriptions.

    bus = SimpleNamespace(publish=lambda event: metrics.update(['condition_events']))
    owner = ContinuousMonitors(Path('/tmp/hoga-volume-shadow-no-data'), bus,
        SimpleNamespace(volume_replica=replica), targets, loader=loader)

    async def resolve(_req):
        return codes

    owner.resolve = resolve
    request = ScanRequest.model_validate(dict(basis='intraday', universe=dict(scopes=['watchlist', 'heatmap']),
        conditions=[dict(id='shadow-volume', type='new_high_vol', params=dict(timeframe='1m', period=100, lookback=5))
                    ]))
    monitor_status = await owner.start(epoch, request)
    monitor = owner.get(monitor_status.id)
    adapter = ContinuousAdapter(owner, monitor)
    first_ready_ms = None

    async def observe_status():
        nonlocal health, first_ready_ms
        while True:
            health = await asyncio.to_thread(read, args.origin, '/api/live/status')
            owner.get(monitor.id, touch=True)
            status = owner.status(monitor, now())
            if status.prepared == len(codes) and first_ready_ms is None:
                first_ready_ms = now() - clock_start
            metrics['max_prepared'] = max(metrics['max_prepared'], status.prepared)
            metrics['max_receiving'] = max(metrics['max_receiving'], status.receiving)
            await asyncio.sleep(2)

    async def compare_completed():
        sample = [code for code in ['005930', '000660', '006400', '035420', '012450', '373220', '005490', '011200']
                  if code in codes]
        while True:
            await asyncio.sleep(45)
            for code in sample:
                snapshot = await loader(None, code, '1m', 104, None, datetime.now(KST))
                state = replica.get(code, now())
                if not state:
                    continue
                expected = {bar.start_ms: bar.volume for bar in snapshot.bars}
                newest = max(expected, default=0)
                for start, observed, valid in state['bars']:
                    if not valid or start < (clock_start // MINUTE + 1) * MINUTE or start + MINUTE + 15_000 > now():
                        continue
                    if start in expected and start < newest:
                        compare.append(dict(code=code, start_ms=start, ws_volume=observed,
                                            api_volume=expected[start], equal=observed == expected[start]))

    try:
        jobs = [asyncio.create_task(coro) for coro in [receive_states(), frames(),
            outbox.send(outgoing[1]), observe_status(), compare_completed()]]
        async with websockets.connect(args.origin.replace('http', 'ws', 1) + '/api/ws', max_size=8*1024*1024) as ws:
            for code in codes:
                await ws.send(json.dumps(dict(action='subscribe', code=code, venues=['KRX'], protocol=2)))
            deadline = time.monotonic() + args.duration
            while time.monotonic() < deadline:
                try:
                    frame = json.loads(await asyncio.wait_for(ws.recv(), max(1, deadline-time.monotonic())))
                except TimeoutError:
                    break
                if frame.get('ch') == 'live_batch':
                    if frame.get('dropped'):
                        stream = source.streams.get(frame['code'])
                        if stream:
                            stream.healthy_since, stream.last_cum = now(), None
                            if stream.bars:
                                stream.bars[-1].valid = False
                        metrics['public_ws_dropped'] += frame['dropped']
                    for entry in frame['data']:
                        if entry.get('kind') == 'trade':
                            source.ingest(frame['code'], entry, now())
                            metrics['trade_frames'] += 1
                if any(task.done() for task in jobs):
                    for task in jobs:
                        if task.done():
                            task.result()
            final_coverage = owner.status(monitor, now()).model_dump()
            # Reading repeated result inputs must not initiate history loading.
            before = metrics['history_http_requests']
            for _ in range(3):
                for code in codes:
                    adapter.snapshot(monitor.leaves[0], code, now())
            metrics['history_requests_from_result_reads'] = metrics['history_http_requests'] - before
    finally:
        await owner.close()
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)
        for _, writer in [incoming, outgoing]:
            writer.close()
            with contextlib.suppress(OSError):
                await writer.wait_closed()
    final_status = await asyncio.to_thread(read, args.origin, '/api/live/status')
    unique = {(row['code'], row['start_ms']): row for row in compare}
    latencies = sorted(event_latencies)
    def percentile(q):
        return latencies[min(len(latencies)-1, int(len(latencies)*q))] if latencies else None
    result = dict(started_ms=clock_start, finished_ms=now(), duration_seconds=args.duration,
        production_health=await asyncio.to_thread(read, args.origin, '/health'),
        requested=len(requested), existing_ready=len(candidates), sampled_codes=codes,
        already_ready=len(codes), coverage=final_coverage,
        first_all_prepared_ms=first_ready_ms, metrics=dict(metrics),
        comparisons=list(unique.values()), matched_comparisons=sum(r['equal'] for r in unique.values()),
        mismatches=sum(not r['equal'] for r in unique.values()),
        local_ipc_delivery_ms=dict(p50=percentile(.5),p95=percentile(.95),p99=percentile(.99)),
        history_http_seconds_max=max(seed_seconds, default=0), internal_outbox=outbox.snapshot(),
        subscription_count_before=initial_status['kiwoom']['subscribed_count'],
        subscription_count_after=final_status['kiwoom']['subscribed_count'],
        limitations='Shadow uses the existing production public WS; it adds no second vendor connection. '
        'The public WS may report gaps. New absolute state IPC and monitor histories are isolated. '
        'Only sampled completed bars are compared. Local IPC timing excludes provider and browser latency. '
        'Production code is unchanged during this run.',
        source_sha256_before=initial_hashes,
        unchanged_sources=initial_hashes == {p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in inspected},
        source_sha256={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in inspected})
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({k:v for k,v in result.items() if k not in {'comparisons', 'source_sha256',
        'source_sha256_before'}}, ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', default='http://127.0.0.1:8000')
    parser.add_argument('--duration', type=int, default=180)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(validate(args))


if __name__ == '__main__':
    main()
