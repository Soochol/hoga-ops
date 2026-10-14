import type { RangeBundle } from '../../src/api/types';

/** Projector tests specify only the surface under test, including deliberately
 * incomplete wire points. Keep that assertion at the fixture boundary. */
export function rangeBundleFixture(overrides: object): RangeBundle {
  return {
    code: 'test', from_date: '', to_date: '', bucket_ms: 60_000, segments: [], candles: [],
    quote_ratio: { bucket_ms: 60_000, points: [] }, fill_strength: { bucket_ms: 60_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [], volume_distributions: [], investorPoints: [], ask_peaks: [], broker_late_entries: [],
    ...overrides,
  } as RangeBundle;
}
