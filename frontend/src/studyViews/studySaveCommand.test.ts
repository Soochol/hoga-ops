import { describe, expect, it } from 'vitest';
import type { ParquetStudySnapshot, ParquetStudyView, StudyIndicatorState } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { LiveStudySaveSource, StoredStudySaveSource } from './studySaveSource';
import { makeStudySaveCommand } from './studySaveCommand';

const indicatorState: StudyIndicatorState = {
  volume_enabled: true,
  quote_totals_enabled: true,
  ratio_enabled: true,
  fill_strength_enabled: true,
  aggregation_basis: 'close',
  auction_window_mask: true,
  ratio_outlier_filter_enabled: true,
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
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
      { ts_ms: 3_000, open: 3, high: 4, low: 3, close: 4, vol_a: 12, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: overrides.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: [],
    ...overrides,
  };
}

function savedView(overrides: Partial<ParquetStudyView> = {}): ParquetStudyView {
  return {
    id: 'view1',
    name: '기존 저장뷰',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    memo: '기존 메모',
    tags: [],
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 3_000,
    viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: false },
    indicator_state: indicatorState,
    provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
    snapshot_schema_version: 1,
    snapshot_path: 'study_views/snapshots/view1.json',
    snapshot_size_bytes: 100,
    created_at_ms: 1,
    updated_at_ms: 2,
    ...overrides,
  };
}

function snapshot(): ParquetStudySnapshot {
  return {
    schema_version: 1,
    source_policy: 'fixed',
    code: '005930',
    label: '삼성전자',
    timeframe: '5m',
    snapshot_from_ms: 1_000,
    snapshot_to_ms: 3_000,
    bucket_kind: '5m',
    viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: false },
    indicator_state: indicatorState,
    provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
    bundle: {
      code: '005930',
      timeframe: '5m',
      snapshot_from_ms: 1_000,
      snapshot_to_ms: 3_000,
      segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 4_000 }],
      candles: [],
      quote_totals: [],
      ratio: [],
      fill_strength: [],
      ask_peaks: [],
      data_warnings: [],
    },
    captured_at_ms: 4_000,
  };
}

describe('makeStudySaveCommand', () => {
  it('builds a create command from a live source using captured viewport and empty dialog name', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle(),
      indicatorState,
      captureViewport: () => ({ rightEdgeMs: 3_000, barSpan: 2, atLiveEdge: true }),
    };

    const command = makeStudySaveCommand({ mode: 'create', source, existingSave: null });

    expect(command).toMatchObject({
      mode: 'create',
      id: undefined,
      defaultName: '',
      defaultMemo: '',
    });
    expect(command?.request).toMatchObject({
      name: '삼성전자 5m 저장뷰',
      code: '005930',
      label: '삼성전자',
      provenance: { saved_from_route: '/live', data_provenance: 'live_mixed' },
      viewport: { right_edge_ms: 3_000, bar_span: 2, at_live_edge: true },
      snapshot_from_ms: 1_000,
      snapshot_to_ms: 3_000,
    });
  });

  it('builds an overwrite command from a study source carrying existing name and memo', () => {
    const source: StoredStudySaveSource = {
      origin: 'study',
      viewId: 'view1',
      snapshot: snapshot(),
      bundle: bundle(),
      captureViewport: () => ({ rightEdgeMs: 2_000, barSpan: 1, atLiveEdge: false }),
    };

    const command = makeStudySaveCommand({ mode: 'overwrite', source, existingSave: savedView() });

    expect(command).toMatchObject({
      mode: 'overwrite',
      id: 'view1',
      defaultName: '기존 저장뷰',
      defaultMemo: '기존 메모',
    });
    expect(command?.request).toMatchObject({
      name: '기존 저장뷰',
      memo: '기존 메모',
      provenance: { saved_from_route: '/study', data_provenance: 'study_snapshot' },
      viewport: { right_edge_ms: 2_000, bar_span: 1, at_live_edge: false },
      snapshot_from_ms: 1_000,
      snapshot_to_ms: 3_000,
    });
  });

  it('returns null when no viewport can be captured or inferred', () => {
    const source: LiveStudySaveSource = {
      origin: 'live',
      code: '005930',
      label: '삼성전자',
      timeframe: '5m',
      bundle: bundle({ candles: [] }),
      indicatorState,
      captureViewport: () => null,
    };

    expect(makeStudySaveCommand({ mode: 'create', source, existingSave: null })).toBeNull();
  });
});
