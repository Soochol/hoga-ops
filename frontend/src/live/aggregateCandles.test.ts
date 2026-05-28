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

// Regression for ADR-0048 / D-direct spec D7:
// aggregateCalendar('D', dailyInput) must be identity-ish — input is
// already daily bars, one per trading day, so each bar gets its own
// bucket and the OHLCV is preserved verbatim.
describe("aggregateCalendar('D') with already-daily input", () => {
  it('passes daily bars through unchanged (one bucket per bar)', () => {
    const kst = (y: number, m: number, d: number) => {
      // 09:00 KST → UTC ms
      const utc = Date.UTC(y, m - 1, d, 0, 0); // 09:00 KST = 00:00 UTC
      return utc;
    };
    const input = [
      { t_ms: kst(2024, 1, 2), open: 100, high: 110, low: 95, close: 105, volume: 1000 },
      { t_ms: kst(2024, 1, 3), open: 105, high: 115, low: 100, close: 112, volume: 2000 },
      { t_ms: kst(2024, 1, 4), open: 112, high: 120, low: 108, close: 118, volume: 1500 },
    ];
    const out = aggregateCalendar(input, 'D');
    expect(out).toHaveLength(3);
    out.forEach((bar, i) => {
      expect(bar.t_ms).toBe(input[i].t_ms);
      expect(bar.open).toBe(input[i].open);
      expect(bar.high).toBe(input[i].high);
      expect(bar.low).toBe(input[i].low);
      expect(bar.close).toBe(input[i].close);
      expect(bar.volume).toBe(input[i].volume);
    });
  });

  it('aggregateCalendar(W) with daily bars within one ISO week → single bucket', () => {
    const kst = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d, 0, 0);
    // Mon 2024-01-01 through Fri 2024-01-05 — all same week.
    const input = [
      { t_ms: kst(2024, 1, 1), open: 100, high: 110, low: 90, close: 105, volume: 100 },
      { t_ms: kst(2024, 1, 2), open: 105, high: 120, low: 100, close: 115, volume: 200 },
      { t_ms: kst(2024, 1, 3), open: 115, high: 125, low: 110, close: 120, volume: 150 },
      { t_ms: kst(2024, 1, 4), open: 120, high: 130, low: 115, close: 125, volume: 175 },
      { t_ms: kst(2024, 1, 5), open: 125, high: 135, low: 120, close: 130, volume: 225 },
    ];
    const out = aggregateCalendar(input, 'W');
    expect(out).toHaveLength(1);
    expect(out[0].open).toBe(100);     // first bar's open
    expect(out[0].close).toBe(130);    // last bar's close
    expect(out[0].high).toBe(135);     // max of highs
    expect(out[0].low).toBe(90);       // min of lows
    expect(out[0].volume).toBe(850);   // sum of volumes
  });
});
