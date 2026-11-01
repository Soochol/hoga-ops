"""Read-only daily preparation benchmark; never calls a market-data provider."""
from __future__ import annotations

import argparse
import datetime as dt
import json
import statistics
import time
from pathlib import Path

import polars as pl

from hoga.api import (
    screener_series_runner as runner,
    screener_series_store as store,
    screener_snapshot_cache as snapshots,
    screener_universe,
)
from hoga.api.models import ScanRequest
from hoga.util.timeenc import KST


def measure(data_dir, snapshot_id, now):
    pinned = store.load_snapshot(data_dir, snapshot_id)
    if pinned is None:
        raise ValueError('No daily snapshot')
    manifest = pinned[1]
    req = ScanRequest.model_validate(dict(calculation_policy='separate_bases_v2', basis='intraday',
        universe=dict(scopes=['watchlist', 'heatmap']), conditions=[dict(id=tf, type='new_high_vol',
            params=dict(timeframe=tf, period=period, lookback=3, include_open_bar=True, volume_basis='raw'))
            for tf, period in [('3m', 40), ('5m', 24), ('10m', 12)]]))
    roster = pl.DataFrame(store.read_object(data_dir, manifest['roster']))
    scope = screener_universe.scope_codes(data_dir, req.universe.scopes)
    codes = screener_universe.filter_stocks_df(roster, req.universe, scope=scope)['code'].to_list()
    snapshots.shared.clear()
    original_read = store.read_object
    counts = []

    def read(*args):
        counts.append(1)
        return original_read(*args)

    def timed(function, *args, **kwargs):
        counts.clear()
        started = time.perf_counter()
        value = function(*args, **kwargs)
        return value, dict(seconds=time.perf_counter() - started, object_reads=len(counts))

    rounds, baseline = [], None
    store.read_object = read
    try:
        for index in range(4):
            confirmed, one = timed(runner._confirmed_at, data_dir, manifest, codes, now.date())
            daily, two = timed(runner.calendar_evaluate, data_dir, req, pinned, codes, now,
                               fallback_clock=runner._eod_clock(now, confirmed))
            metadata, three = timed(runner._daily_contract, data_dir, manifest, codes)
            values = confirmed, daily, metadata
            identical = baseline is None or values == baseline
            baseline = baseline or values
            row = dict(round=index, phases=dict(confirmed=one, daily=two, metadata=three),
                       seconds=sum(v['seconds'] for v in (one, two, three)),
                       object_reads=sum(v['object_reads'] for v in (one, two, three)), identical=identical)
            rounds.append(row)
            print(json.dumps(row), flush=True)
            if not identical:
                raise AssertionError('Reused daily facts changed')
    finally:
        store.read_object = original_read
    return dict(snapshot=pinned[0], codes=len(codes), code_fingerprint=store.digest(codes), as_of=now.isoformat(),
                api_calls=0, rounds=rounds, warm_median_seconds=statistics.median(r['seconds'] for r in rounds[1:]),
                cache_bytes=snapshots.shared.bytes, cache_entries=len(snapshots.shared.entries))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--snapshot')
    parser.add_argument('--as-of', default=dt.datetime.now(KST).isoformat())
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = measure(args.data_dir, args.snapshot, dt.datetime.fromisoformat(args.as_of).astimezone(KST))
    args.output.write_text(json.dumps(result, indent=2))
    print(json.dumps(result), flush=True)
