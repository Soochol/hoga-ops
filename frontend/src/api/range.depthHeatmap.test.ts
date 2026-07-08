import { describe, it, expect } from 'vitest';

import { mergeRangeBundles } from './range';
import type { RangeBundle } from './types';

// Minimal valid bundle mirroring range.test.tsx's fakeBundle fixture.
const fakeBundle: RangeBundle = {
  code: '005930', from_date: '20260512', to_date: '20260512', bucket_ms: 60_000,
  segments: [], candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

describe('depth_heatmap merge', () => {
  it('버킷 t_ms 단위로 dedup하고 오름차순 정렬한다 (latest-wins)', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      from_date: '20260624',
      to_date: '20260706',
      depth_heatmap: [
        { t_ms: 50, asks: [[7, 7]], bids: [] },
        { t_ms: 100, asks: [], bids: [] },
      ],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      from_date: '20260706',
      to_date: '20260706',
      depth_heatmap: [
        { t_ms: 100, asks: [[1, 2]], bids: [] },
        { t_ms: 200, asks: [], bids: [] },
      ],
    };

    const merged = mergeRangeBundles(previous, next);

    // union of both buckets, dedup by t_ms, ascending order
    expect(merged.depth_heatmap!.map((p) => p.t_ms)).toEqual([50, 100, 200]);
    // overlapping t_ms → next (latest) wins
    expect(merged.depth_heatmap!.find((p) => p.t_ms === 100)!.asks).toEqual([[1, 2]]);
  });

  it('한쪽만 depth_heatmap을 가지면 그쪽 값을 보존한다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      depth_heatmap: [{ t_ms: 50, asks: [[9, 9]], bids: [[8, 8]] }],
    };
    const next: RangeBundle = { ...fakeBundle };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.depth_heatmap!.map((p) => p.t_ms)).toEqual([50]);
  });
});
