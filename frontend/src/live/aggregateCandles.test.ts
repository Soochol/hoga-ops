import { describe, it, expect } from 'vitest';
import { aggregateCandles, aggregateCalendar } from './aggregateCandles';

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

  it('dedupes within a 60s bucket — bars sharing the same minute merge into one', () => {
    // Regression guard (2026-05-28): pre-f63ed15 KIS-cache files leak duplicate
    // ts_ms values into past-candles responses. useLiveBundle routes 1m
    // through aggregateCandles(_, 60) so the merge collapses dupes before the
    // chart sees them; without this, lightweight-charts asserts non-monotonic
    // time in RangeSeriesPane.setData. See useLiveBundle.ts:94.
    const baseMs = 1779840000000; // 09:00:00 KST, aligned to a 60s bucket
    const src = [
      { t_ms: baseMs, open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { t_ms: baseMs, open: 99, high: 102, low: 98, close: 101, volume: 20 },
      { t_ms: baseMs + 60_000, open: 101, high: 103, low: 100, close: 102, volume: 5 },
    ];
    const out = aggregateCandles(src, 60);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      t_ms: baseMs,
      open: 100,        // first bar's open wins
      high: 102,        // max across merged bars
      low: 98,           // min across merged bars
      close: 101,        // last merged bar's close wins
      volume: 30,        // sum
    });
    expect(out[1].t_ms).toBe(baseMs + 60_000);
  });
});

describe('aggregateCalendar', () => {
  // Helper: 09:00 KST of YYYY-M-D as Unix ms (00:00 UTC = 09:00 KST).
  const sessionOpenKst = (y: number, m1: number, d: number): number =>
    Date.UTC(y, m1 - 1, d, 0, 0, 0);
  const bar = (t_ms: number, price: number, vol = 1) => ({
    t_ms,
    open: price,
    high: price,
    low: price,
    close: price,
    volume: vol,
  });

  it('returns empty for empty input', () => {
    expect(aggregateCalendar([], 'D')).toEqual([]);
  });

  it('D: groups all KST same-day bars into one bucket; t_ms = first bar', () => {
    // 2026-05-27 KST: 09:00, 09:01, 15:30. 2026-05-28 KST: 09:00.
    const may27Open = sessionOpenKst(2026, 5, 27);
    const may28Open = sessionOpenKst(2026, 5, 28);
    const src = [
      bar(may27Open, 100, 10),
      bar(may27Open + 60_000, 105, 5),
      bar(may27Open + 6.5 * 3600 * 1000, 102, 3), // 15:30 KST same day
      bar(may28Open, 110, 2),
    ];
    const out = aggregateCalendar(src, 'D');
    expect(out).toHaveLength(2);
    expect(out[0].t_ms).toBe(may27Open); // first bar's ts wins (= sessionOpen)
    expect(out[0]).toMatchObject({ open: 100, high: 105, low: 100, close: 102, volume: 18 });
    expect(out[1].t_ms).toBe(may28Open);
    expect(out[1].volume).toBe(2);
  });

  it('W: groups Mon→Sun bars; Sun and following Mon split into two buckets', () => {
    // 2026-05-25 Mon, 26 Tue → week A. 2026-06-01 Mon → week B.
    const monA = sessionOpenKst(2026, 5, 25);
    const tueA = sessionOpenKst(2026, 5, 26);
    const monB = sessionOpenKst(2026, 6, 1);
    const out = aggregateCalendar([bar(monA, 10), bar(tueA, 12), bar(monB, 15)], 'W');
    expect(out).toHaveLength(2);
    expect(out[0].t_ms).toBe(monA);
    expect(out[1].t_ms).toBe(monB);
  });

  it('W: Sunday is the LAST day of its week, not the first', () => {
    // 2026-05-24 is Sunday (week ending). 2026-05-25 Mon starts next week.
    const sun = sessionOpenKst(2026, 5, 24);
    const mon = sessionOpenKst(2026, 5, 25);
    const out = aggregateCalendar([bar(sun, 1), bar(mon, 2)], 'W');
    expect(out).toHaveLength(2);
    expect(out[0].t_ms).toBe(sun);
    expect(out[1].t_ms).toBe(mon);
  });

  it('M: groups by calendar month — KST date matters', () => {
    const may31 = sessionOpenKst(2026, 5, 31);
    const jun1 = sessionOpenKst(2026, 6, 1);
    const jun30 = sessionOpenKst(2026, 6, 30);
    const out = aggregateCalendar([bar(may31, 1), bar(jun1, 2), bar(jun30, 3)], 'M');
    expect(out).toHaveLength(2);
    expect(out[0].t_ms).toBe(may31);
    expect(out[1].t_ms).toBe(jun1);
  });

  it('KST shift: a bar at UTC 14:30 belongs to NEXT KST day', () => {
    // 2026-05-27 14:30 UTC = 2026-05-27 23:30 KST → still 27th
    // 2026-05-27 15:30 UTC = 2026-05-28 00:30 KST → 28th
    const utc1430 = Date.UTC(2026, 4, 27, 14, 30);
    const utc1530 = Date.UTC(2026, 4, 27, 15, 30);
    const out = aggregateCalendar([bar(utc1430, 1), bar(utc1530, 2)], 'D');
    expect(out).toHaveLength(2);
  });
});
