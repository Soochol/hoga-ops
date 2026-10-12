import { describe, expect, it } from 'vitest';
import { computeBollingerBands } from './bollingerBands';

describe('computeBollingerBands', () => {
  it('uses population deviation and waits for a complete trailing window', () => {
    const values = computeBollingerBands([1, 2, 3, 4], 3, 2);
    expect(values.slice(0, 2)).toEqual([null, null]);
    expect(values[2]?.middle).toBe(2);
    expect(values[2]?.upper).toBeCloseTo(2 + 2 * Math.sqrt(2 / 3));
    expect(values[2]?.lower).toBeCloseTo(2 - 2 * Math.sqrt(2 / 3));
    expect(values[3]?.middle).toBe(3);
    expect(values[3]?.upper).toBeCloseTo(3 + 2 * Math.sqrt(2 / 3));
  });

  it('keeps flat prices coincident, including large prices with tiny variance', () => {
    expect(computeBollingerBands([100, 100, 100], 2, 2)[2]).toEqual({ middle: 100, upper: 100, lower: 100 });
    const point = computeBollingerBands([1e12, 1e12 + 1, 1e12 + 2], 3, 2)[2]!;
    expect(point.middle).toBe(1e12 + 1);
    expect(point.upper - point.middle).toBeCloseTo(2 * Math.sqrt(2 / 3), 3);
  });

  it('matches an independent two-pass calculation across many rolling windows', () => {
    const prices = Array.from({ length: 3000 }, (_, i) => 50000 + Math.sin(i * 0.7) * 1000 + i * 10);
    for (const period of [1, 2, 20, 400]) {
      const out = computeBollingerBands(prices, period, 1.9);
      for (let i = period - 1; i < prices.length; i++) {
        const window = prices.slice(i - period + 1, i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / period;
        const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
        expect(out[i]?.middle).toBeCloseTo(mean, 7);
        expect(out[i]?.upper).toBeCloseTo(mean + 1.9 * sd, 7);
      }
    }
  });

  it('recovers once invalid values leave the window', () => {
    const out = computeBollingerBands([1, NaN, 3, 4, 5], 2, 2);
    expect(out.slice(0, 3)).toEqual([null, null, null]);
    expect(out[3]).toEqual({ middle: 3.5, upper: 4.5, lower: 2.5 });
    expect(out[4]).toEqual({ middle: 4.5, upper: 5.5, lower: 3.5 });
    expect(computeBollingerBands([], 20, 2)).toEqual([]);
    for (const period of [0, -1, 1.5, NaN]) expect(computeBollingerBands([1, 2], period, 2)).toEqual([null, null]);
  });
});
