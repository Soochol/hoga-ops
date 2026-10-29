import { describe, expect, it } from 'vitest';
import type { Candle } from '../../api/types';
import { bearishRayEndMs, computeNewHighBearishOpen as compute, domesticDailyCandleClosed } from './newHighBearishOpen';

export function sampleCandles(): Candle[] {
  const ohlc = [
    ...Array.from({ length: 5 }, () => [100, 101, 99, 100]),
    [110, 120, 109, 110], [109, 111, 99, 100], [99, 100, 89, 90], [89, 90, 79, 80],
    [120, 130, 119, 125], [124, 125, 89, 90],
  ];
  return ohlc.map(([open, high, low, close], i) => ({ ts_ms: Date.UTC(2026, 8, i + 1), open, high, low, close, vol_a: 1, vol_b: 0 }));
}
const indexes = (xs: ReturnType<typeof compute>, cs: Candle[]) => xs.map(x => cs.findIndex(c => c.ts_ms === x.ts_ms));
describe('new-high bearish open lines', () => {
  it('finds the first qualifying candle per high, retains old lines and anchors the open', () => {
    const cs = sampleCandles(); const result = compute(cs, 5, 7, 1);
    expect(indexes(result, cs)).toEqual([6, 10]);
    expect(result[0]).toEqual({ ts_ms: cs[6].ts_ms, price: 109, highTsMs: cs[5].ts_ms, ordinal: 1 });
  });
  it('finds only two qualifying candles per high, resetting both count and high anchor', () => {
    const cs = sampleCandles(); const result = compute(cs, 5, 7, 2);
    expect(indexes(result, cs)).toEqual([6, 7, 10]);
    expect(result.map(x => x.ordinal)).toEqual([1, 2, 1]);
  });
  it('uses the prior N highs and does not count an equal high as a renewal', () => {
    const cs = sampleCandles(); cs[6].high = 120;
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[6].ts_ms);
    expect(indexes(compute(cs, 8, 7, 1), cs)).toEqual([10]);
  });
  it('excludes a high-day bearish candle and restarts before counting that candle', () => {
    const cs = sampleCandles(); cs[5] = { ...cs[5], open: 119, low: 90 };
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[6].ts_ms);
    cs[6].high = 121;
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[7].ts_ms);
  });
  it('includes exactly -7%, keeps fractional thresholds, and uses the wick rather than close', () => {
    const cs = sampleCandles(); cs[6].low = 102.3; cs[6].close = 102.4;
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[6].ts_ms);
    expect(compute(cs, 5, 7.1, 1)[0].ts_ms).toBe(cs[7].ts_ms);
  });
  it.each(['doji', 'green', 'ma-equal', 'above-ma', 'insufficient-drop'] as const)('does not consume a slot for %s', kind => {
    const cs = sampleCandles();
    if (kind === 'doji') cs[6].open = cs[6].close;
    if (kind === 'green') cs[6].open = 99;
    if (kind === 'ma-equal') cs[6].close = 102.5;
    if (kind === 'above-ma') cs[6].close = 105;
    if (kind === 'insufficient-drop') { cs[6].low = 103; cs[6].close = 104; }
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[7].ts_ms);
  });
  it('requires warmup, excludes unfinished bars and recomputes corrected data without mutation', () => {
    const cs = sampleCandles(), before = structuredClone(cs);
    expect(compute(cs, 200, 7, 1)).toEqual([]);
    expect(compute(cs, 5, 7, 2, c => c.ts_ms < cs[6].ts_ms)).toEqual([]);
    expect(compute(cs, 5, 7, 1)).toHaveLength(2);
    expect(cs).toEqual(before);
    cs[6].close = 105;
    expect(compute(cs, 5, 7, 1)[0].ts_ms).toBe(cs[7].ts_ms);
  });
  it('resets on invalid OHLC instead of bridging a corrupt bar', () => {
    const cs = sampleCandles(); cs[6].close = NaN;
    expect(compute(cs, 5, 7, 2)).toEqual([]);
  });
  it('uses the venue close time, not the daily display timestamp', () => {
    const ts = Date.parse('2026-10-29T09:00:00+09:00');
    const at = (s: string) => Date.parse(`2026-10-29T${s}+09:00`);
    expect(domesticDailyCandleClosed(ts, at('15:29:59'), 'KRX')).toBe(false);
    expect(domesticDailyCandleClosed(ts, at('15:30:00'), 'KRX')).toBe(true);
    expect(domesticDailyCandleClosed(ts, at('15:30:00'), 'UN')).toBe(false);
    expect(domesticDailyCandleClosed(ts, at('20:00:00'), 'NXT')).toBe(true);
  });
});

it('uses calendar months and clamps month-end including leap years', () => {
  const t = (s: string) => Date.parse(`${s}T09:00:00+09:00`);
  expect(bearishRayEndMs(t('2026-08-31'), 6)).toBe(t('2027-02-28'));
  expect(bearishRayEndMs(t('2023-08-31'), 6)).toBe(t('2024-02-29'));
  expect(bearishRayEndMs(t('2026-10-29'), 3)).toBe(t('2027-01-29'));
});
