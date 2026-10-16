"""Aggregate raw regular books/trades, never clip an already ranked day."""
from __future__ import annotations

import json
from pathlib import Path

import polars as pl
import pytest
from fastapi.testclient import TestClient

from hoga.api.app import create_app
from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.api.sources import source_venue_dir
from hoga.util.timeenc import hhmmssms_to_unix_ms

DATE = '20260914'
CODE = '005930'


def write_day(root: Path, venue: str) -> None:
    folder = source_venue_dir(root / 'parquet' / DATE / CODE, 'kiwoom_live', venue)
    folder.mkdir(parents=True, exist_ok=True)
    folder.joinpath('meta.json').write_text(json.dumps(dict(
        code=CODE, name='삼성전자', source='kiwoom_live', date=DATE,
        regular_session_open_ms=90000000, regular_session_close_ms=153000000,
        indicator_session_open_ms=90000000 if venue == 'KRX' else 80000000,
        indicator_session_close_ms=200000000, collection_complete=True, is_partial=False,
        prev_close=100, upper_limit=200, lower_limit=50, today_open=100,
        today_high=190, today_low=60, today_close=150, pages_collected=1,
        total_unique_events=5, parser_version='test',
    )))
    books, trades, candles = [], [], []
    # The morning candidate is outside the full day's top three. A nested-array
    # timestamp filter cannot recover it. Off-session candles also change bins.
    for seq, (clock, price, qty) in enumerate([
        (83000000, 70, 500), (100000000, 100, 10), (154500000, 100, 9999),
        (160000000, 150, 100), (180000000, 160, 200), (195900000, 170, 300),
    ]):
        row = dict(ts_ms=clock, seq=seq, phase='regular')
        for level in range(1, 11):
            row.update({f'ask_p{level}': price+level, f'bid_p{level}': price-level,
                        f'ask_q{level}': qty, f'bid_q{level}': qty})
        books.append(row)
        # Touch the ask and bid in the same minute, continuous side only.
        for side in (-1, 1):
            trades.append(dict(ts_ms=clock, seq=seq*2+side, price=price+side,
                               qty=qty, side=side, cum_vol=qty))
        candle_ms = clock // 10000000 * 3600000 + clock // 100000 % 100 * 60000
        candles.append(dict(ts_ms=candle_ms, open=price, high=price+10, low=price-10,
                            close=price, vol_a=qty, vol_b=qty))
    pl.DataFrame(books).write_parquet(folder / 'snapshots.parquet')
    pl.DataFrame(trades).write_parquet(folder / 'trades.parquet')
    pl.DataFrame(candles).write_parquet(folder / 'candles.parquet')


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_badge_aggregates_raw_regular_session_and_keeps_full_session_cache(tmp_path, venue):
    write_day(tmp_path, venue)
    engine = QueryEngine(tmp_path)
    args = dict(code=CODE, from_date=DATE, to_date=DATE, bucket_ms=60000,
                venue=venue, source_pref='kiwoom_live', mode='sidecar',
                broker_late_entries_enabled=False, program_trade_enabled=False,
                depth_heatmap_enabled=False, volume_distribution_bins=10,
                trade_volume_poc_bins=10, bar_peaks_enabled=True,
                all_bar_peaks_enabled=True, unreached_bar_peaks_enabled=True)
    full = build_range_bundle(engine, **args)
    assert not full.excluded_dates
    regular = build_range_bundle(engine, **args, regular_session_only=True)
    assert regular.ask_peaks and regular.bid_peaks
    for peak in [*regular.ask_peaks, *regular.bid_peaks]:
        assert peak.qty == 10  # survives although full-day top-3 is outside regular hours
        for key, points in peak.model_dump().items():
            if key.endswith('peaks') and points:
                assert all(hhmmssms_to_unix_ms(DATE, 90000000) <= p['t_ms'] <=
                           hhmmssms_to_unix_ms(DATE, 153000000) for p in points)
    assert regular.ask_peaks[0].unreached_peaks
    assert regular.bid_peaks[0].unreached_peaks
    profile = regular.volume_distributions[0]
    assert (profile.price_min, profile.price_max) == (90, 110)
    assert sum(b.qty for b in profile.bins) == 20
    assert all(b.first_trade_ms == hhmmssms_to_unix_ms(DATE, 100000000)
               for b in profile.bins if b.qty)
    assert regular.trade_volume_pocs[0].qty == 10
    coarse = build_range_bundle(engine, **(args | {"bucket_ms": 3600000}), regular_session_only=True)
    assert coarse.ask_peaks[0].max_qty == 10
    assert coarse.bid_peaks[0].max_qty == 10
    assert coarse.volume_distributions == regular.volume_distributions
    assert coarse.trade_volume_pocs == regular.trade_volume_pocs
    full_profile = full.volume_distributions[0]
    expected = 2 * (10 + 100 + 200 + 300 + (0 if venue == 'KRX' else 500+9999))
    assert sum(b.qty for b in full_profile.bins) == expected
    assert full_profile.last_trade_ms == hhmmssms_to_unix_ms(DATE, 195900000)
    assert full.trade_volume_pocs[0].qty > regular.trade_volume_pocs[0].qty
    assert build_range_bundle(engine, **args) == full  # scoped query cannot poison cache
    assert build_range_bundle(engine, **args, regular_session_only=True) == regular
    # The current-day TTL/single-flight cache must also separate both scopes.
    from unittest.mock import patch
    with patch('hoga.api.bundle._today_kst_yyyymmdd', return_value=DATE):
        for scoped, expected_bundle in [(False, full), (True, regular), (False, full)]:
            current = build_range_bundle(engine, **args, regular_session_only=scoped)
            assert current.volume_distributions == expected_bundle.volume_distributions
            assert current.trade_volume_pocs == expected_bundle.trade_volume_pocs
            assert current.ask_peaks[0].qty == expected_bundle.ask_peaks[0].qty
    engine.close()


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_range_http_forwards_badge_scope(tmp_path, venue):
    write_day(tmp_path, venue)
    client = TestClient(create_app(data_dir=tmp_path))
    params = dict(code=CODE, **{'from': DATE, 'to': DATE}, bucket_ms=60000,
                  venue=venue, source_pref='kiwoom_live', mode='sidecar',
                  volume_distribution_bins=10, regular_session_only='true')
    response = client.get('/api/range', params=params)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result['ask_peaks'][0]['qty'] == 10
    assert sum(b['qty'] for b in result['volume_distributions'][0]['bins']) == 20


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_regular_view_does_not_fall_back_to_evening_price_grid_when_regular_candles_are_missing(tmp_path, venue):
    write_day(tmp_path, venue)
    folder = source_venue_dir(tmp_path / 'parquet' / DATE / CODE, 'kiwoom_live', venue)
    path = folder / 'candles.parquet'
    pl.read_parquet(path).filter(pl.col('ts_ms') >= 16 * 3600000).write_parquet(path)
    engine = QueryEngine(tmp_path)
    args = dict(code=CODE, from_date=DATE, to_date=DATE, bucket_ms=60000, mode='sidecar',
                venue=venue, source_pref='kiwoom_live', volume_distribution_bins=10,
                program_trade_enabled=False, broker_late_entries_enabled=False)
    assert build_range_bundle(engine, **args).volume_distributions
    regular = build_range_bundle(engine, **args, regular_session_only=True)
    assert regular.volume_distributions == []
    assert regular.trade_volume_pocs == []
    engine.close()
