import { describe, it, expect } from 'vitest';
import type { RangeBundle, QuoteRatioPoint } from '../api/types';
import { deriveQuoteTotalsLevels, deriveRatioLevel } from './deriveQuoteLevelLines';

const pt = (over: Partial<QuoteRatioPoint>): QuoteRatioPoint => ({
  t: 0,
  bid_total: 0,
  ask_total: 0,
  bid_max: 0,
  ask_max: 0,
  imb_max_bid: 0,
  imb_max_ask: 0,
  ...over,
});

// candles=[] keeps withHogaGapSentinels from injecting gap sentinels, so the
// projected points equal the input points for these unit tests.
const bundleOf = (points: QuoteRatioPoint[]): RangeBundle =>
  ({ quote_ratio: { bucket_ms: 60_000, points }, candles: [], bucket_ms: 60_000 } as unknown as RangeBundle);

describe('deriveQuoteTotalsLevels', () => {
  it('returns the last bucket bid/ask totals (intraMax=false)', () => {
    const b = bundleOf([
      pt({ t: 1, bid_total: 100, ask_total: 200 }),
      pt({ t: 2, bid_total: 300, ask_total: 400 }),
    ]);
    expect(deriveQuoteTotalsLevels(b, false)).toEqual({ bid: 300, ask: 400 });
  });

  it('uses bid_max/ask_max when intraMax=true', () => {
    const b = bundleOf([pt({ t: 1, bid_total: 100, ask_total: 200, bid_max: 500, ask_max: 600 })]);
    expect(deriveQuoteTotalsLevels(b, true)).toEqual({ bid: 500, ask: 600 });
  });

  it('skips a synthetic hoga-gap tail point', () => {
    const b = bundleOf([
      pt({ t: 1, bid_total: 100, ask_total: 200 }),
      { ...pt({ t: 2 }), __syntheticHogaGap: true } as unknown as QuoteRatioPoint,
    ]);
    expect(deriveQuoteTotalsLevels(b, false)).toEqual({ bid: 100, ask: 200 });
  });

  it('returns null for an empty bundle', () => {
    expect(deriveQuoteTotalsLevels(bundleOf([]), false)).toBeNull();
  });
});

describe('deriveRatioLevel', () => {
  it('is positive when ask dominates (sell heavy)', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, bid_total: 100, ask_total: 200 })]), false);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(0);
  });

  it('is negative when bid dominates (buy heavy)', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, bid_total: 300, ask_total: 100 })]), false);
    expect(v as number).toBeLessThan(0);
  });

  it('uses imb_max fields when intraMax=true', () => {
    const v = deriveRatioLevel(bundleOf([pt({ t: 1, imb_max_bid: 100, imb_max_ask: 200 })]), true);
    expect(v as number).toBeGreaterThan(0);
  });

  it('returns null for an empty bundle', () => {
    expect(deriveRatioLevel(bundleOf([]), false)).toBeNull();
  });
});
