import { describe, expect, it, vi } from 'vitest';
import { buildStudySnapshotRequest } from './useStudySnapshotCapture';
import type { RangeBundle } from '../api/types';
import type { StudyIndicatorState } from '../api/studyViews';
import type { StudySnapshotRangeBundle } from './studySnapshotAdapter';

const indicatorState: StudyIndicatorState = {
  volume_enabled: true,
  quote_totals_enabled: true,
  ratio_enabled: true,
  fill_strength_enabled: true,
  aggregation_basis: 'close',
  auction_window_mask: false,
  ratio_outlier_filter_enabled: false,
  ratio_outlier_threshold: 50,
  volume_distribution_enabled: true,
  volume_distribution_range_count: 10,
  volume_distribution_color: '#64748B',
  volume_distribution_max_color: '#EAB308',
};

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 4_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 1 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 2 },
      { ts_ms: 3_000, open: 3, high: 4, low: 3, close: 4, vol_a: 12, vol_b: 3 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [
        { t: 1_000, bid_total: 100, ask_total: 100, bid_max: 100, ask_max: 100, imb_max_bid: 100, imb_max_ask: 100 },
        { t: 2_000, bid_total: 100, ask_total: 200, bid_max: 120, ask_max: 500, imb_max_bid: 10, imb_max_ask: 50 },
        { t: 3_000, bid_total: 200, ask_total: 100, bid_max: 300, ask_max: 100, imb_max_bid: 300, imb_max_ask: 100 },
      ],
    },
    fill_strength: {
      bucket_ms: 300_000,
      points: [
        { t: 1_000, buy_qty: 5, sell_qty: 4 },
        { t: 2_000, buy_qty: 6, sell_qty: 3 },
        { t: 3_000, buy_qty: 7, sell_qty: 2 },
      ],
    },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [
      {
        date: '20260616',
        range_count: 10,
        price_min: 69_000,
        price_max: 71_000,
        session_open_ms: 1_000,
        session_close_ms: 4_000,
        bins: [{ price_low: 69_000, price_high: 69_200, qty: 100 }],
      },
      {
        date: '20260615',
        range_count: 10,
        price_min: 68_000,
        price_max: 70_000,
        session_open_ms: 1,
        session_close_ms: 999,
        bins: [{ price_low: 68_000, price_high: 68_200, qty: 90 }],
      },
    ],
    investorPoints: [],
    broker_late_entries: [],
    ask_peaks: [
      {
        date: '20260616',
        price: 70_500,
        qty: 5_000,
        t_ms: 2_000,
        max_price: 70_700,
        max_qty: 6_000,
        max_t_ms: 3_000,
        all_price: 70_900,
        all_qty: 7_000,
        all_t_ms: 3_000,
        all_max_price: 71_000,
        all_max_qty: 8_000,
        all_max_t_ms: 3_000,
      },
      {
        date: '20260615',
        price: 69_500,
        qty: 4_000,
        t_ms: 1,
        max_price: 69_700,
        max_qty: 4_500,
        max_t_ms: 1,
      },
    ],
    bid_peaks: [
      {
        date: '20260616',
        price: 69_900,
        qty: 4_800,
        t_ms: 2_000,
        max_price: 69_800,
        max_qty: 5_800,
        max_t_ms: 3_000,
      },
      {
        date: '20260615',
        price: 68_900,
        qty: 3_800,
        t_ms: 1,
        max_price: 68_800,
        max_qty: 4_300,
        max_t_ms: 1,
      },
    ],
    trade_volume_pocs: [
      {
        date: '20260616',
        center_price: 70_000,
        low_price: 69_500,
        high_price: 70_500,
        qty: 12_345,
        t_ms: 2_000,
        band_pct: 0.0025,
      },
      {
        date: '20260615',
        center_price: 69_000,
        low_price: 68_500,
        high_price: 69_500,
        qty: 5_000,
        t_ms: 1,
        band_pct: 0.005,
      },
    ],
    program_trade: {
      points: [
        { t: 1_000, net_qty: 10, net_amount: 100_000_000, delta_amount: 100_000_000, gap_risk: false },
        { t: 2_000, net_qty: 20, net_amount: 200_000_000, delta_amount: 100_000_000, gap_risk: false },
        { t: 3_000, net_qty: -5, net_amount: -50_000_000, delta_amount: -250_000_000, gap_risk: true },
      ],
    },
    ...overrides,
  };
}

function build(overrides: Partial<Parameters<typeof buildStudySnapshotRequest>[0]> = {}) {
  return buildStudySnapshotRequest({
    name: '삼성전자 5분봉 2026.06.16',
    memo: '메모',
    route: '/live',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    viewport: { right_edge_ms: 3_000, bar_span: 200, at_live_edge: false },
    indicatorState,
    bundle: bundle(),
    fromIndex: 1,
    toIndex: 2,
    capturedAtMs: 9_000,
    ...overrides,
  });
}

describe('buildStudySnapshotRequest', () => {
  it('builds a write request from the captured candle window', () => {
    const req = build();

    expect(req).toMatchObject({
      name: '삼성전자 5분봉 2026.06.16',
      memo: '메모',
      tags: [],
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      snapshot_from_ms: 2_000,
      snapshot_to_ms: 3_000,
      provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
    });
    expect(req.snapshot).toMatchObject({
      schema_version: 1,
      captured_at_ms: 9_000,
      bucket_kind: '5m',
      snapshot_from_ms: 2_000,
      snapshot_to_ms: 3_000,
    });
    expect(req.snapshot.bundle.candles).toEqual([
      { t: 2_000, open: 2, high: 3, low: 2, close: 3, volume: 13 },
      { t: 3_000, open: 3, high: 4, low: 3, close: 4, volume: 15 },
    ]);
    expect(req.snapshot.bundle.quote_totals).toEqual([
      { t: 2_000, bid_total: 100, ask_total: 200, visible: true },
      { t: 3_000, bid_total: 200, ask_total: 100, visible: true },
    ]);
    expect(req.snapshot.bundle.fill_strength).toEqual([
      { t: 2_000, buy_qty: 6, sell_qty: 3, visible: true },
      { t: 3_000, buy_qty: 7, sell_qty: 2, visible: true },
    ]);
    expect(req.snapshot.bundle.program_trade).toEqual({
      points: [
        { t: 2_000, net_qty: 20, net_amount: 200_000_000, delta_amount: 100_000_000, gap_risk: false },
        { t: 3_000, net_qty: -5, net_amount: -50_000_000, delta_amount: -250_000_000, gap_risk: true },
      ],
    });
    expect(req.snapshot.bundle.ask_peaks).toEqual([
      {
        date: '20260616',
        price: 70_500,
        qty: 5_000,
        t_ms: 2_000,
        max_price: 70_700,
        max_qty: 6_000,
        max_t_ms: 3_000,
        all_price: 70_900,
        all_qty: 7_000,
        all_t_ms: 3_000,
        all_max_price: 71_000,
        all_max_qty: 8_000,
        all_max_t_ms: 3_000,
      },
    ]);
    expect(req.snapshot.bundle.bid_peaks).toEqual([
      {
        date: '20260616',
        price: 69_900,
        qty: 4_800,
        t_ms: 2_000,
        max_price: 69_800,
        max_qty: 5_800,
        max_t_ms: 3_000,
      },
    ]);
    expect(req.snapshot.bundle.trade_volume_pocs).toEqual([
      {
        date: '20260616',
        center_price: 70_000,
        low_price: 69_500,
        high_price: 70_500,
        qty: 12_345,
        t_ms: 2_000,
        band_pct: 0.0025,
      },
    ]);
    expect(req.snapshot.bundle.volume_distributions).toEqual([
      {
        date: '20260616',
        range_count: 10,
        price_min: 69_000,
        price_max: 71_000,
        session_open_ms: 1_000,
        session_close_ms: 4_000,
        bins: [{ price_low: 69_000, price_high: 69_200, qty: 100 }],
      },
    ]);
  });

  it('preserves daily moving average indicator settings in the saved snapshot state', () => {
    const dailyMaState = {
      ...indicatorState,
      daily_moving_average_enabled: true,
      daily_moving_average_hidden: false,
      daily_moving_averages: [
        { id: 'dma-20', enabled: true, period: 20, color: '#EAB308', line_width: 2, source: 'close' },
        { id: 'dma-60', enabled: false, period: 60, color: '#22C55E', line_width: 1, source: 'hl2' },
      ],
    };

    const req = build({ indicatorState: dailyMaState as never });

    expect(req.indicator_state).toMatchObject({
      daily_moving_average_enabled: true,
      daily_moving_average_hidden: false,
      daily_moving_averages: [
        { id: 'dma-20', enabled: true, period: 20, color: '#EAB308', line_width: 2, source: 'close' },
        { id: 'dma-60', enabled: false, period: 60, color: '#22C55E', line_width: 1, source: 'hl2' },
      ],
    });
    expect(req.snapshot.indicator_state).toEqual(req.indicator_state);
  });

  it('preserves trade volume POC indicator settings in the saved snapshot state', () => {
    const pocState = {
      ...indicatorState,
      trade_volume_poc_enabled: true,
      trade_volume_poc_band_pct: 0.0025,
      trade_volume_poc_color: '#22C55E',
      trade_volume_poc_opacity: 0.28,
    };

    const req = build({ indicatorState: pocState });

    expect(req.indicator_state).toMatchObject({
      trade_volume_poc_enabled: true,
      trade_volume_poc_band_pct: 0.0025,
      trade_volume_poc_color: '#22C55E',
      trade_volume_poc_opacity: 0.28,
    });
    expect(req.snapshot.indicator_state).toEqual(req.indicator_state);
  });

  it('preserves volume distribution indicator settings in the saved snapshot state', () => {
    const distributionState = {
      ...indicatorState,
      volume_distribution_enabled: false,
      volume_distribution_range_count: 24,
      volume_distribution_color: '#22C55E',
      volume_distribution_max_color: '#EF4444',
    };

    const req = build({ indicatorState: distributionState });

    expect(req.indicator_state).toMatchObject({
      volume_distribution_enabled: false,
      volume_distribution_range_count: 24,
      volume_distribution_color: '#22C55E',
      volume_distribution_max_color: '#EF4444',
    });
    expect(req.snapshot.indicator_state).toEqual(req.indicator_state);
  });

  it('derives ratio with the same quoteImbalance semantics as the chart', () => {
    const req = build();

    expect(req.snapshot.bundle.ratio).toEqual([
      { t: 2_000, value: 1, visible: true },
      { t: 3_000, value: -1, visible: true },
    ]);
  });

  it('uses intra-period max ratio inputs and outlier masking when those prefs are captured', () => {
    const req = build({
      indicatorState: {
        ...indicatorState,
        aggregation_basis: 'intra_period_max',
        ratio_outlier_filter_enabled: true,
        ratio_outlier_threshold: 4,
      },
    });

    expect(req.snapshot.bundle.ratio).toEqual([
      { t: 2_000, value: 0, visible: true },
      { t: 3_000, value: -2, visible: true },
    ]);
  });

  it('preserves saved study ratio display points when recapturing a study snapshot', () => {
    const studyBundle: StudySnapshotRangeBundle = {
      ...bundle(),
      study_ratio: {
        bucket_ms: 300_000,
        points: [
          { t: 1_000, value: 999 },
          { t: 2_000, value: -49 },
          { t: 3_000, value: 2 },
        ],
      },
    };

    const req = build({ route: '/study', bundle: studyBundle });

    expect(req.provenance).toEqual({ saved_from_route: '/study', data_provenance: 'study_snapshot' });
    expect(req.snapshot.bundle.ratio).toEqual([
      { t: 2_000, value: -49, visible: true },
      { t: 3_000, value: 2, visible: true },
    ]);
  });

  it('marks disabled and auction-masked indicator points hidden without numeric values', () => {
    const req = build({
      indicatorState: {
        ...indicatorState,
        quote_totals_enabled: false,
        ratio_enabled: false,
        fill_strength_enabled: false,
        auction_window_mask: true,
      },
      bundle: bundle({
        segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 + 10 * 60_000 }],
      }),
      fromIndex: 1,
      toIndex: 1,
    });

    expect(req.snapshot.bundle.quote_totals).toEqual([{ t: 2_000, visible: false }]);
    expect(req.snapshot.bundle.ratio).toEqual([{ t: 2_000, visible: false }]);
    expect(req.snapshot.bundle.fill_strength).toEqual([{ t: 2_000, visible: false }]);
  });

  it('defaults memo, tags, and capturedAt when optional args are omitted', () => {
    vi.useFakeTimers();
    vi.setSystemTime(12_345);
    const req = buildStudySnapshotRequest({
      name: '기본값',
      route: '/live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      viewport: { right_edge_ms: 3_000, bar_span: 200, at_live_edge: false },
      indicatorState,
      bundle: bundle(),
      fromIndex: 1,
      toIndex: 1,
    });

    expect(req.memo).toBe('');
    expect(req.tags).toEqual([]);
    expect(req.snapshot.captured_at_ms).toBe(12_345);
    vi.useRealTimers();
  });
});
