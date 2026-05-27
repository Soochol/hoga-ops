import { describe, it, expect } from 'vitest';
import { aggregateCandles } from './aggregateCandles';

describe('aggregateCandles', () => {
  it('returns empty for empty input', () => {
    expect(aggregateCandles([], 60)).toEqual([]);
  });

  it('merges 5 1m bars into one 5m bucket aligned to epoch', () => {
    const baseMs = 1779840000000; // 09:00:00 KST
    const src = [
      { t_ms: baseMs + 0 * 60_000, open: 100, high: 105, low: 99, close: 102, volume: 10 },
      { t_ms: baseMs + 1 * 60_000, open: 102, high: 108, low: 101, close: 107, volume: 12 },
      { t_ms: baseMs + 2 * 60_000, open: 107, high: 110, low: 104, close: 105, volume: 8 },
      { t_ms: baseMs + 3 * 60_000, open: 105, high: 106, low: 100, close: 101, volume: 15 },
      { t_ms: baseMs + 4 * 60_000, open: 101, high: 103, low: 98, close: 99, volume: 5 },
    ];
    const out = aggregateCandles(src, 300);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      t_ms: baseMs,
      open: 100,
      high: 110,
      low: 98,
      close: 99,
      volume: 50,
    });
  });

  it('emits separate buckets when bars cross a bucket boundary', () => {
    // Two buckets of 3m each: 09:00-09:03 contains 09:00, 09:01, 09:02;
    // 09:03-09:06 contains 09:03, 09:04.
    const baseMs = 1779840000000;
    const src = [
      { t_ms: baseMs + 0 * 60_000, open: 100, high: 100, low: 100, close: 100, volume: 1 },
      { t_ms: baseMs + 1 * 60_000, open: 100, high: 101, low: 100, close: 101, volume: 1 },
      { t_ms: baseMs + 2 * 60_000, open: 101, high: 102, low: 100, close: 102, volume: 1 },
      { t_ms: baseMs + 3 * 60_000, open: 102, high: 103, low: 102, close: 103, volume: 1 },
      { t_ms: baseMs + 4 * 60_000, open: 103, high: 104, low: 103, close: 104, volume: 1 },
    ];
    const out = aggregateCandles(src, 180);
    expect(out).toHaveLength(2);
    expect(out[0].t_ms).toBe(baseMs);
    expect(out[0].open).toBe(100);
    expect(out[0].close).toBe(102);
    expect(out[1].t_ms).toBe(baseMs + 3 * 60_000);
    expect(out[1].open).toBe(102);
    expect(out[1].close).toBe(104);
  });

  it('rejects non-positive bucketSec', () => {
    expect(() => aggregateCandles([], 0)).toThrow();
    expect(() => aggregateCandles([], -60)).toThrow();
  });
});
