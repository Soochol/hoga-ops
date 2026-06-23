import { describe, expect, it } from 'vitest';
import type { Candle } from '../api/types';
import { buildCandlePriceCoverage } from './candlePriceCoverage';

const candle = (ts_ms: number, low: number, high: number): Candle => ({
  ts_ms,
  open: low,
  high,
  low,
  close: high,
  vol_a: 0,
  vol_b: 0,
});

describe('buildCandlePriceCoverage', () => {
  it('matches prices inclusively inside today candle low/high ranges', () => {
    const today = Date.UTC(2026, 5, 23, 0, 0, 0);
    const covers = buildCandlePriceCoverage([candle(today, 100, 105)], '20260623');

    expect(covers(99)).toBe(false);
    expect(covers(100)).toBe(true);
    expect(covers(103)).toBe(true);
    expect(covers(105)).toBe(true);
    expect(covers(106)).toBe(false);
  });

  it('ignores candles outside todayKst', () => {
    const previousKstDay = Date.UTC(2026, 5, 22, 0, 0, 0);
    const covers = buildCandlePriceCoverage([candle(previousKstDay, 100, 105)], '20260623');

    expect(covers(103)).toBe(false);
  });

  it('ignores non-finite candle ranges and prices', () => {
    const today = Date.UTC(2026, 5, 23, 0, 0, 0);
    const covers = buildCandlePriceCoverage([
      { ...candle(today, 100, 105), low: Number.NaN },
      { ...candle(today, 200, 205), high: Number.POSITIVE_INFINITY },
    ], '20260623');

    expect(covers(102)).toBe(false);
    expect(covers(202)).toBe(false);
    expect(covers(Number.NaN)).toBe(false);
  });

  it('handles many disjoint ranges without scanning every candle per lookup', () => {
    const today = Date.UTC(2026, 5, 23, 0, 0, 0);
    const covers = buildCandlePriceCoverage(
      Array.from({ length: 1000 }, (_, i) => candle(today + i * 60_000, i * 10, i * 10 + 2)),
      '20260623',
    );

    expect(covers(4992)).toBe(true);
    expect(covers(4993)).toBe(false);
  });
});
