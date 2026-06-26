import { describe, expect, it } from 'vitest';
import type { StudyIndicatorState } from '../api/studyViews';
import type { RangeBundle } from '../api/types';
import type { StudySnapshotRangeBundle } from './studySnapshotAdapter';
import { projectStudySnapshotHoga } from './studySnapshotProjection';

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

function bundle(): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 4_000 }],
    candles: [],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [
        { t: 1_000, bid_total: 100, ask_total: 100, bid_max: 100, ask_max: 100, imb_max_bid: 100, imb_max_ask: 100 },
        { t: 2_000, bid_total: 100, ask_total: 200, bid_max: 120, ask_max: 500, imb_max_bid: 10, imb_max_ask: 50 },
      ],
    },
    fill_strength: {
      bucket_ms: 300_000,
      points: [
        { t: 1_000, buy_qty: 5, sell_qty: 4 },
        { t: 2_000, buy_qty: 6, sell_qty: 3 },
      ],
    },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    broker_late_entries: [],
  };
}

describe('projectStudySnapshotHoga', () => {
  it('projects live hoga display data into snapshot indicator series', () => {
    const projected = projectStudySnapshotHoga({
      route: '/live',
      bundle: bundle(),
      indicatorState,
      segments: bundle().segments,
      from: 1_000,
      to: 2_000,
    });

    expect(projected.quote_totals).toEqual([
      { t: 1_000, bid_total: 100, ask_total: 100, visible: true },
      { t: 2_000, bid_total: 100, ask_total: 200, visible: true },
    ]);
    expect(projected.ratio).toEqual([
      { t: 1_000, value: 0, visible: true },
      { t: 2_000, value: 1, visible: true },
    ]);
    expect(projected.fill_strength).toEqual([
      { t: 1_000, buy_qty: 5, sell_qty: 4, visible: true },
      { t: 2_000, buy_qty: 6, sell_qty: 3, visible: true },
    ]);
  });

  it('preserves study ratio display values and applies visibility masking', () => {
    const studyBundle: StudySnapshotRangeBundle = {
      ...bundle(),
      study_ratio: {
        bucket_ms: 300_000,
        points: [
          { t: 1_000, value: -49 },
          { t: 2_000, value: 2 },
        ],
      },
    };

    const projected = projectStudySnapshotHoga({
      route: '/study',
      bundle: studyBundle,
      indicatorState: {
        ...indicatorState,
        quote_totals_enabled: false,
        auction_window_mask: true,
      },
      segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 + 10 * 60_000 }],
      from: 1_000,
      to: 2_000,
    });

    expect(projected.quote_totals).toEqual([
      { t: 1_000, visible: false },
      { t: 2_000, visible: false },
    ]);
    expect(projected.ratio).toEqual([
      { t: 1_000, value: -49, visible: true },
      { t: 2_000, visible: false },
    ]);
  });
});
