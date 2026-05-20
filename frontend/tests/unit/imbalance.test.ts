import { describe, it, expect } from 'vitest';
import { quoteImbalance } from '../../src/util/imbalance';

describe('quoteImbalance', () => {
  it('returns 0 at balance', () => expect(quoteImbalance(100, 100)).toBe(0));
  it('returns +0.2 when ask is 1.2× bid (sell heavy)', () =>
    expect(quoteImbalance(100, 120)).toBeCloseTo(0.2, 5));
  it('returns -0.2 when bid is 1.2× ask (buy heavy)', () =>
    expect(quoteImbalance(120, 100)).toBeCloseTo(-0.2, 5));
  it('returns 0 when bid is 0', () => expect(quoteImbalance(0, 100)).toBe(0));
  it('returns 0 when ask is 0', () => expect(quoteImbalance(100, 0)).toBe(0));
  it('handles 2× extreme', () => {
    expect(quoteImbalance(100, 200)).toBeCloseTo(1.0, 5);
    expect(quoteImbalance(200, 100)).toBeCloseTo(-1.0, 5);
  });
});
