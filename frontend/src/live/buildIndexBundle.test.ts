import { describe, expect, it } from 'vitest';
import { buildIndexBundle } from './buildIndexBundle';

describe('buildIndexBundle', () => {
  it('converts index candles into a hoga-free RangeBundle', () => {
    const bundle = buildIndexBundle({
      indexId: 'KOSPI',
      from: '20260619',
      to: '20260619',
      bucketMs: 86_400_000,
      candles: [
        { t_ms: 1_781_830_800_000, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, volume: 450000000 },
      ],
      investorPoints: [
        { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
      ],
    });

    expect(bundle.code).toBe('index:KOSPI');
    expect(bundle.candles).toEqual([
      { ts_ms: 1_781_830_800_000, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, vol_a: 450000000, vol_b: 0 },
    ]);
    expect(bundle.quote_ratio.points).toEqual([]);
    expect(bundle.fill_strength.points).toEqual([]);
    expect(bundle.investorPoints).toEqual([
      { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
    ]);
    expect(bundle.ask_peaks).toEqual([]);
    expect(bundle.broker_late_entries).toEqual([]);
    expect(bundle.segments[0].date).toBe('20260619');
  });
});
