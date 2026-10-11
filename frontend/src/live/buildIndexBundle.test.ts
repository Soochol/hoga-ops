import { describe, expect, it } from 'vitest';
import { buildIndexBundle } from './buildIndexBundle';

describe('buildIndexBundle', () => {
  it('preserves actual calendar turnover including zero without inferring missing amounts', () => {
    const bundle = buildIndexBundle({
      indexId: 'KOSDAQ', from: '20260619', to: '20260619', bucketMs: 86_400_000,
      candles: [18840196000000, 0, null, undefined].map((trade_value_won, i) => ({
        t_ms: 1_781_830_800_000 + i * 1000, open: 2800, high: 2800, low: 2800,
        close: 2800, volume: 450000000, trade_value_won,
      })),
    });
    expect(bundle.candles.map(c => c.trade_value_won)).toEqual([18840196000000, 0, undefined, undefined]);
  });

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
