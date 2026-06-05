import { describe, it, expect } from 'vitest';
import { quoteImbalance } from './imbalance';

describe('quoteImbalance', () => {
  it('returns 0 for a balanced book', () => {
    expect(quoteImbalance(100, 100)).toBe(0);
  });

  it('is positive (sell-heavy) when ask > bid', () => {
    // ask/bid - 1 = 200/100 - 1 = 1.0
    expect(quoteImbalance(100, 200)).toBeCloseTo(1.0, 5);
  });

  it('is negative (buy-heavy) when bid > ask', () => {
    // -(bid/ask - 1) = -(200/100 - 1) = -1.0
    expect(quoteImbalance(200, 100)).toBeCloseTo(-1.0, 5);
  });

  // Degenerate (≤0) contract — load-bearing for ADR-0062: a fully-auction
  // bucket is excluded by emitting (0,0) totals (bucketHogaSeries /
  // query_bucketed_ratio). The ratio projector (chart/projectors/ratio.ts)
  // relies on this returning 0 (not NaN/Infinity) so an excluded bucket
  // renders flat at 0 instead of corrupting the BaselineSeries.
  it('returns 0 for a fully-empty (0,0) book — no 0/0 NaN', () => {
    const v = quoteImbalance(0, 0);
    expect(v).toBe(0);
    expect(Number.isNaN(v)).toBe(false);
  });

  it('returns 0 when only one side is 0 — no x/0 Infinity', () => {
    expect(quoteImbalance(0, 500)).toBe(0);
    expect(quoteImbalance(500, 0)).toBe(0);
    expect(Number.isFinite(quoteImbalance(0, 500))).toBe(true);
    expect(Number.isFinite(quoteImbalance(500, 0))).toBe(true);
  });

  it('returns 0 for negative inputs', () => {
    expect(quoteImbalance(-1, 100)).toBe(0);
    expect(quoteImbalance(100, -1)).toBe(0);
  });
});
