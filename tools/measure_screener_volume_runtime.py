"""Synthetic tick-path benchmark and committed-master capacity estimate.

Run: uv run python tools/measure_screener_volume_runtime.py
Does not connect to a broker, start a server or change subscriptions.
"""
from __future__ import annotations

import json
import math
import time
from collections import Counter
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

from hoga.api.screener_bar_volume import MinuteSnapshot, VolumeBar
from hoga.live.coverage import KIWOOM_PER_ACCOUNT_MAX, KIWOOM_SECTOR_RESERVE, venue_weight
from hoga.live.screener_volume import MAX_BARS, MAX_WATCHES, ScreenerVolumeRuntime
from hoga.util.timeenc import KST


def measure(codes=512, ticks=100_000):
    now = int(datetime(2026, 10, 20, 12, 0, 1, tzinfo=KST).timestamp() * 1000)
    runtime = ScreenerVolumeRuntime()
    leaf = SimpleNamespace(id='volume', type='new_high_vol', params=SimpleNamespace(
        period=100, lookback=5, timeframe='1m', include_open_bar=True))
    names = [f'{i:06d}' for i in range(codes)]
    for code in names:
        data = [VolumeBar(now // 60_000 * 60_000 - (103 - i) * 60_000, 1_000_000) for i in range(104)]
        runtime.seed(leaf, code, MinuteSnapshot(data, now), now)
    started = time.perf_counter()
    for i in range(ticks):
        code = names[i % codes]
        runtime.ingest(code, dict(kind='trade', venue='KRX', t_ms=now + i // codes,
            cum_volume=1000 + i // codes,
            trades=[dict(t_ms=now + i // codes, qty=1, price=100)]), now + i // codes)
    elapsed = time.perf_counter() - started
    watched = min(codes, MAX_WATCHES)
    processed = sum(i % codes >= codes - watched for i in range(ticks))
    out = dict(codes=codes, ticks=ticks, elapsed_s=round(elapsed, 4),
               ticks_per_second=round(ticks / elapsed), processed_ticks=processed,
               ignored_ticks=ticks - processed, prepared=runtime.counts([leaf], names, now)[0])
    runtime.close()
    return out


def main():
    root = Path(__file__).resolve().parents[1]
    rows = json.loads((root / 'hoga/api/kiwoom_master_seed.json').read_text())['rows']
    stocks = [row for row in rows if row[2] in {'KOSPI', 'KOSDAQ'} and row[3] == 'stock']
    nxt = {row[0]: row[4] for row in stocks}
    registrations = sum(venue_weight(row[0], nxt) for row in stocks)
    print(json.dumps(dict(
        master_markets=dict(Counter(row[2] for row in stocks)), master_stocks=len(stocks),
        current_venue_registrations=registrations,
        minimum_accounts_current_venues=math.ceil((registrations + KIWOOM_SECTOR_RESERVE) / KIWOOM_PER_ACCOUNT_MAX),
        minimum_accounts_krx_only=math.ceil((len(stocks) + KIWOOM_SECTOR_RESERVE) / KIWOOM_PER_ACCOUNT_MAX),
        max_watches=MAX_WATCHES, max_bars=MAX_BARS,
        synthetic=[measure(), measure(codes=5000)],
    ), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
