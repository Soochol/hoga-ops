import { describe, expect, it } from 'vitest';

import type { RangeBundle } from '../../api/types';
import {
  quoteRatioPointsForBundle,
  quoteRatioPointsForSlice,
} from './quoteRatioPoints';
import { isSyntheticHogaGapPoint } from '../util/hogaGapHide';

function bundle(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260625',
    to_date: '20260625',
    bucket_ms: 60_000,
    segments: [{ date: '20260625', session_open_ms: 1_000, session_close_ms: 300_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 },
      { ts_ms: 61_000, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 },
      { ts_ms: 121_000, open: 1, high: 1, low: 1, close: 1, vol_a: 0, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 60_000,
      points: [
        { t: 1_000, bid_total: 10, ask_total: 20, bid_max: 10, ask_max: 20, imb_max_bid: 10, imb_max_ask: 20 },
        { t: 121_000, bid_total: 30, ask_total: 40, bid_max: 30, ask_max: 40, imb_max_bid: 30, imb_max_ask: 40 },
      ],
    },
    fill_strength: { bucket_ms: 60_000, points: [] },
    program_trade: { points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    trade_volume_pocs: [],
    ...overrides,
  };
}

describe('quote ratio point preparation', () => {
  it('adds hoga-gap sentinels for the whole bundle', () => {
    const points = quoteRatioPointsForBundle(bundle());

    expect(points.some(isSyntheticHogaGapPoint)).toBe(true);
    expect(points.filter((point) => !isSyntheticHogaGapPoint(point)).map((point) => point.t)).toEqual([1_000, 121_000]);
  });

  it('adds slice sentinels using the all-point boundaries', () => {
    const b = bundle();
    const points = quoteRatioPointsForSlice({
      bundle: b,
      points: b.quote_ratio.points.slice(1),
      allPoints: b.quote_ratio.points,
      fromT: 61_000,
      toT: 181_000,
    });

    expect(points.some(isSyntheticHogaGapPoint)).toBe(true);
    expect(points.filter((point) => !isSyntheticHogaGapPoint(point)).map((point) => point.t)).toEqual([121_000]);
  });
});
