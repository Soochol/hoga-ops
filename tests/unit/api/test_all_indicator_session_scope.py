"""The remaining time series must clip raw inputs before coarse aggregation."""
from __future__ import annotations

import polars as pl
import pytest

from hoga.api.bundle import build_range_bundle
from hoga.api.queries import QueryEngine
from hoga.api.sources import source_venue_dir
from hoga.live.program_trade_store import ProgramTradeByStockRow, ProgramTradeStore
from hoga.util.timeenc import hhmmssms_to_unix_ms
from tests.unit.api.test_range_indicator_sessions import CODE, DATE, write_day


def args(venue, mode):
    return dict(code=CODE, from_date=DATE, to_date=DATE, venue=venue,
                source_pref='kiwoom_live', mode=mode, broker_late_entries_enabled=False,
                program_trade_enabled=False, ask_peaks_enabled=False, bid_peaks_enabled=False,
                trade_volume_poc_enabled=False, depth_heatmap_enabled=False)


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
@pytest.mark.parametrize('artifact', ['trades', 'fills'])
def test_fill_strength_scopes_raw_inputs_before_sum_and_isolates_both_caches(tmp_path, venue, artifact):
    write_day(tmp_path, venue)
    if artifact == 'fills':
        folder = source_venue_dir(tmp_path / 'parquet' / DATE / CODE, 'kiwoom_live', venue)
        pl.DataFrame([dict(ts_ms=t, seq=i, buy_qty=q, sell_qty=q)
                      for i, (t, q) in enumerate([(83000000, 500), (100000000, 10),
                         (154500000, 9999), (160000000, 100), (180000000, 200), (195900000, 300)])
                      ]).write_parquet(folder / 'fills.parquet')
    engine = QueryEngine(tmp_path)
    try:
        expected = 2*(10+100+200+300+(0 if venue == 'KRX' else 500+9999))
        for bucket_ms in (60000, 3600000, 7200000, 14400000):
            kw = {**args(venue, 'hoga'), 'bucket_ms': bucket_ms}
            full = build_range_bundle(engine, **kw)
            regular = build_range_bundle(engine, **kw, regular_session_only=True)
            assert sum(p.buy_qty+p.sell_qty for p in full.fill_strength.points) == expected
            assert sum(p.buy_qty+p.sell_qty for p in regular.fill_strength.points) == 20
            assert full.quote_ratio.points[-1].t >= hhmmssms_to_unix_ms(DATE, 160000000)
            assert {p.bid_total for p in regular.quote_ratio.points if p.bid_total} == {100}
            assert all(hhmmssms_to_unix_ms(DATE, 90000000) <= p.t <=
                       hhmmssms_to_unix_ms(DATE, 153000000) for p in regular.fill_strength.points)
            assert build_range_bundle(engine, **kw).fill_strength == full.fill_strength
        from unittest.mock import patch
        with patch('hoga.api.bundle._today_kst_yyyymmdd', return_value=DATE):
            for regular, qty in [(True, 20), (False, expected), (True, 20)]:
                b = build_range_bundle(engine, **args(venue, 'hoga'), bucket_ms=3600000,
                                       regular_session_only=regular)
                assert sum(p.buy_qty+p.sell_qty for p in b.fill_strength.points) == qty
    finally:
        engine.close()


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_candle_only_scope_precedes_aggregation(tmp_path, venue):
    write_day(tmp_path, venue)
    engine = QueryEngine(tmp_path)
    try:
        for bucket in (60000, 3600000, 7200000, 14400000):
            kw = {**args(venue, 'candles'), 'bucket_ms': bucket}
            full = build_range_bundle(engine, **kw)
            regular = build_range_bundle(engine, **kw, regular_session_only=True)
            assert full.candles and regular.candles
            assert max(c.high for c in regular.candles) == 110
            assert min(c.low for c in regular.candles) == 90
            assert max(c.high for c in full.candles) == 180
            assert regular.segments[0].session_open_ms == hhmmssms_to_unix_ms(DATE, 90000000)
            assert regular.segments[0].session_close_ms == hhmmssms_to_unix_ms(DATE, 153000000)
    finally:
        engine.close()


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_program_trade_filters_samples_before_coarse_bucketing(tmp_path, venue):
    write_day(tmp_path, venue)
    store = ProgramTradeStore(tmp_path)
    samples = [(100000000, '100000', 10), (154500000, '154500', 9999), (195900000, '195900', 300)]
    rows = [ProgramTradeByStockRow(code=CODE, bsop_hour=clock, t_ms=hhmmssms_to_unix_ms(DATE, packed),
             price=100, net_qty=q, net_amount=q, buy_qty=None, sell_qty=None,
             buy_amount=None, sell_amount=None, delta_qty=None, delta_amount=None)
            for packed, clock, q in samples]
    store.merge_response(code=CODE, date=DATE, venue=venue, rows=rows, observed_at_ms=1)
    engine = QueryEngine(tmp_path)
    try:
        for bucket in (60000, 3600000, 7200000, 14400000):
            kw = {**args(venue, 'sidecar'), 'program_trade_enabled': True, 'bucket_ms': bucket}
            full = build_range_bundle(engine, **kw)
            regular = build_range_bundle(engine, **kw, regular_session_only=True)
            assert full.program_trade.points[-1].net_amount == 300
            assert [p.net_amount for p in regular.program_trade.points] == [10]
            assert build_range_bundle(engine, **kw).program_trade == full.program_trade
    finally:
        engine.close()


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_depth_heatmap_includes_evening_and_regular_scope_is_isolated(tmp_path, venue):
    write_day(tmp_path, venue)
    engine = QueryEngine(tmp_path)
    try:
        kw = {**args(venue, 'sidecar'), 'bucket_ms': 60000, 'depth_heatmap_enabled': True}
        full = build_range_bundle(engine, **kw)
        regular = build_range_bundle(engine, **kw, regular_session_only=True)
        assert full.depth_heatmap[-1].t_ms == hhmmssms_to_unix_ms(DATE, 195900000)
        assert [p.t_ms for p in regular.depth_heatmap] == [hhmmssms_to_unix_ms(DATE, 100000000)]
        assert build_range_bundle(engine, **kw).depth_heatmap == full.depth_heatmap
    finally:
        engine.close()


@pytest.mark.parametrize('venue', ['KRX', 'NXT', 'UN'])
def test_broker_event_regular_scope_clips_display_without_rewriting_seen_set(tmp_path, venue, monkeypatch):
    from hoga.api import bundle
    from hoga.api.models import BrokerLateEntryEvent
    write_day(tmp_path, venue)
    events = [BrokerLateEntryEvent(t_ms=hhmmssms_to_unix_ms(DATE, clock), broker='NH', side='buy', net=10)
              for clock in (100000000, 195900000)]
    monkeypatch.setattr(bundle, 'build_broker_late_entries_slice', lambda *a, **kw: events)
    engine = QueryEngine(tmp_path)
    try:
        kw = {**args(venue, 'sidecar'), 'bucket_ms': 60000, 'broker_late_entries_enabled': True}
        assert build_range_bundle(engine, **kw).broker_late_entries == events
        assert build_range_bundle(engine, **kw, regular_session_only=True).broker_late_entries == events[:1]
        assert build_range_bundle(engine, **kw).broker_late_entries == events
    finally:
        engine.close()
