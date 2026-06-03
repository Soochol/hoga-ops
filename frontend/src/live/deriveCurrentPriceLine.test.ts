import { describe, it, expect } from 'vitest';
import { deriveCurrentPriceLine } from './deriveCurrentPriceLine';
import type { RangeBundle } from '../api/types';
import type { LiveQuote } from '../api/liveQuotes';

const COLORS = { up: 'UP', down: 'DOWN', neutral: 'NEUTRAL' };

function bundleWith(closes: number[]): RangeBundle {
  return {
    candles: closes.map((c, i) => ({
      ts_ms: i * 1000, open: c, close: c, high: c, low: c, vol_a: 0, vol_b: 0,
    })),
  } as RangeBundle;
}

function quote(over: Partial<LiveQuote>): LiveQuote {
  return { code: '005930', price: 0, change_pct: null, change_won: null, ...over };
}

describe('deriveCurrentPriceLine', () => {
  it('returns null when there are no candles', () => {
    expect(deriveCurrentPriceLine(bundleWith([]), undefined, COLORS)).toBeNull();
  });

  it('uses the last candle close as the price', () => {
    const m = deriveCurrentPriceLine(
      bundleWith([100, 200, 70000]),
      quote({ change_won: 0, change_pct: 0 }),
      COLORS,
    );
    expect(m).toEqual({ price: 70000, color: 'NEUTRAL' });
  });

  it('colors up when change_won is positive', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: 500, change_pct: 0.7 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('colors down when change_won is negative', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: -300, change_pct: -0.4 }), COLORS);
    expect(m?.color).toBe('DOWN');
  });

  it('falls back to change_pct sign when change_won is null (OPEN-phase quote)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: 1.2 }), COLORS);
    expect(m?.color).toBe('UP');
  });

  it('is neutral when both change fields are null (pre-open)', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), quote({ change_won: null, change_pct: null }), COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });

  it('is neutral when quote is undefined', () => {
    const m = deriveCurrentPriceLine(bundleWith([70000]), undefined, COLORS);
    expect(m?.color).toBe('NEUTRAL');
  });
});
