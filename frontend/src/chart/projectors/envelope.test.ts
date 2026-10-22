import { describe, expect, it } from 'vitest';
import { computeEnvelope } from './envelope';

describe('computeEnvelope', () => {
  it('waits for a full window and applies the percentage to its mean', () => {
    expect(computeEnvelope([90, 100, 110, 120], 3, 2)).toEqual([
      null, null, { middle: 100, upper: 102, lower: 98 }, { middle: 110, upper: 112.2, lower: 107.8 },
    ]);
    expect(computeEnvelope([100], 1, 0)).toEqual([{ middle: 100, upper: 100, lower: 100 }]);
    expect(computeEnvelope([100], 2, 2)).toEqual([null]);
  });

  it('matches independently calculated rolling windows at long and short periods', () => {
    const prices = Array.from({ length: 1200 }, (_, i) => 50000 + Math.sin(i * .7) * 1000 + i * 10);
    for (const period of [1, 2, 20, 400]) {
      const out = computeEnvelope(prices, period, 3.5);
      for (let i = period - 1; i < prices.length; i++) {
        const mean = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
        expect(out[i]?.middle).toBeCloseTo(mean, 7);
        expect(out[i]?.upper).toBeCloseTo(mean * 1.035, 7);
        expect(out[i]?.lower).toBeCloseTo(mean * .965, 7);
      }
    }
  });

  it('recovers after invalid prices leave the window and rejects invalid parameters', () => {
    expect(computeEnvelope([100, NaN, 90, 110, Infinity, 90, 110], 2, 2)).toEqual([
      null, null, null, { middle: 100, upper: 102, lower: 98 }, null, null, { middle: 100, upper: 102, lower: 98 },
    ]);
    for (const period of [0, -1, 1.5, NaN, Infinity]) expect(computeEnvelope([100], period, 2)).toEqual([null]);
    for (const percent of [-1, NaN, Infinity]) expect(computeEnvelope([100], 1, percent)).toEqual([null]);
    expect(computeEnvelope([], 20, 2)).toEqual([]);
  });
});
