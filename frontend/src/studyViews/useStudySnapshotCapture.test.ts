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
    investorPoints: [],
    ask_peaks: [],
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
