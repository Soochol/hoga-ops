import { describe, expect, it } from 'vitest';
import { indexDayExtremes } from './dayExtremes';
const candle = (time: string, high: number, low: number) => ({ ts_ms: Date.parse(time), high, low, open: low, close: high });

describe('day extrema', () => {
  it('includes all bars in the KST date, independent of visible range and input order', () => {
    const days = indexDayExtremes([
      candle('2026-09-14T15:00:00+09:00', 120, 90),
      candle('2026-09-14T09:00:00+09:00', 110, 80),
      candle('2026-09-15T00:00:00+09:00', 999, 1),
    ]);
    expect(days.get('20260914')).toEqual({ high: 120, low: 80, open: 80, close: 120, highBodyTop: 120 });
    expect(days.get('20260915')).toEqual({ high: 999, low: 1, open: 1, close: 999, highBodyTop: 999 });
    expect(days.get('20260913')).toBeUndefined();
  });
  it('uses a daily candle directly', () => {
    expect(indexDayExtremes([candle('2026-09-14T09:00:00+09:00', 200, 100)]).get('20260914'))
      .toEqual({ high: 200, low: 100, open: 100, close: 200, highBodyTop: 200 });
  });
  it('uses the chronologically first open and last close even when input is unordered', () => {
    const days = indexDayExtremes([
      { ...candle('2026-09-14T15:00:00+09:00', 120, 90), open: 104, close: 105 },
      { ...candle('2026-09-14T09:00:00+09:00', 110, 80), open: 99, close: 100 },
    ]);
    expect(days.get('20260914')?.open).toBe(99);
    expect(days.get('20260914')?.close).toBe(105);
  });
  it('rejects a day with corrupt bounds instead of reporting a partial extreme', () => {
    expect(indexDayExtremes([
      candle('2026-09-14T09:00:00+09:00', 120, 80),
      candle('2026-09-14T10:00:00+09:00', NaN, 70),
    ]).size).toBe(0);
  });

  it.each([
    { open: 100, close: 130, expected: 130 },
    { open: 135, close: 110, expected: 135 },
    { open: 125, close: 125, expected: 125 },
  ])('uses the highest wick candle body for $open → $close', ({ open, close, expected }) => {
    const days = indexDayExtremes([
      { ...candle('2026-09-14T09:00:00+09:00', 145, 90), open: 140, close: 142 },
      { ...candle('2026-09-14T10:00:00+09:00', 150, 90), open, close },
      candle('2026-09-15T09:00:00+09:00', 999, 900),
    ]);
    expect(days.get('20260914')?.highBodyTop).toBe(expected);
  });

  it('breaks equal-high ties by earliest time, independent of input order', () => {
    const early = { ...candle('2026-09-14T09:00:00+09:00', 150, 80), open: 100, close: 120 };
    const late = { ...candle('2026-09-14T15:00:00+09:00', 150, 90), open: 140, close: 130 };
    for (const bars of [[early, late], [late, early]]) {
      expect(indexDayExtremes(bars).get('20260914')?.highBodyTop).toBe(120);
    }
  });
});
