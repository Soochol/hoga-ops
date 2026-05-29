import { describe, it, expect } from 'vitest';
import { computeSMA, selectSource } from './movingAverage';

describe('selectSource', () => {
  const c = { ts_ms: 1000, open: 10, high: 14, low: 6, close: 12, vol_a: 0, vol_b: 0 };

  it('returns close for source="close"', () => {
    expect(selectSource(c, 'close')).toBe(12);
  });
  it('returns open for source="open"', () => {
    expect(selectSource(c, 'open')).toBe(10);
  });
  it('returns high for source="high"', () => {
    expect(selectSource(c, 'high')).toBe(14);
  });
  it('returns low for source="low"', () => {
    expect(selectSource(c, 'low')).toBe(6);
  });
  it('returns (high+low)/2 for source="hl2"', () => {
    expect(selectSource(c, 'hl2')).toBe(10);
  });
  it('returns (high+low+close)/3 for source="hlc3"', () => {
    // (14 + 6 + 12) / 3 = 32 / 3
    expect(selectSource(c, 'hlc3')).toBeCloseTo(32 / 3, 10);
  });
  it('returns (open+high+low+close)/4 for source="ohlc4"', () => {
    // (10 + 14 + 6 + 12) / 4 = 10.5
    expect(selectSource(c, 'ohlc4')).toBe(10.5);
  });
});

describe('computeSMA', () => {
  it('returns sliding-window means with leading nulls for [1..5], period=3', () => {
    expect(computeSMA([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it('returns empty array for empty input', () => {
    expect(computeSMA([], 5)).toEqual([]);
  });

  it('returns all-null when period exceeds input length', () => {
    expect(computeSMA([1, 2, 3], 5)).toEqual([null, null, null]);
  });

  it('returns closes verbatim when period === 1', () => {
    expect(computeSMA([1, 2, 3], 1)).toEqual([1, 2, 3]);
  });

  it('returns all-null when period === 0', () => {
    expect(computeSMA([1, 2, 3], 0)).toEqual([null, null, null]);
  });
});
