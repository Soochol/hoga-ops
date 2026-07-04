import { describe, expect, it } from 'vitest';
import type { AskPeak, BidPeak, Candle } from '../api/types';
import type { IRange, Time } from 'lightweight-charts';
import { createVirtualAxis } from '../util/virtualAxis';
import {
  applyPeakVisibleTimeCutoff,
  rightmostVisibleCandleCutoff,
  type VisibleTimeCutoff,
} from './peakWallVisibleCutoff';

const day1Open = Date.UTC(2026, 5, 10, 0, 0);
const day1Close = Date.UTC(2026, 5, 10, 6, 30);
const day2Open = Date.UTC(2026, 5, 11, 0, 0);
const day2Close = Date.UTC(2026, 5, 11, 6, 30);

const axis = createVirtualAxis([
  { date: '20260610', sessionOpenMs: day1Open, sessionCloseMs: day1Close },
  { date: '20260611', sessionOpenMs: day2Open, sessionCloseMs: day2Close },
], day1Open);

const candle = (ts_ms: number): Candle => ({
  ts_ms,
  open: 1,
  high: 2,
  low: 1,
  close: 2,
  vol_a: 1,
  vol_b: 0,
});

const askPeak = (date: string): AskPeak => ({
  date,
  price: 100,
  qty: 100,
  t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  max_price: 100,
  max_qty: 100,
  max_t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000,
  traded_peaks: [
    { price: 100, qty: 100, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 500, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
  traded_max_peaks: [
    { price: 100, qty: 110, t_ms: date === '20260610' ? day1Open + 60_000 : day2Open + 60_000 },
    { price: 101, qty: 600, t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000 },
  ],
  untraded_price: 102,
  untraded_qty: 700,
  untraded_t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000,
  untraded_max_price: 102,
  untraded_max_qty: 800,
  untraded_max_t_ms: date === '20260610' ? day1Open + 180_000 : day2Open + 180_000,
});

describe('rightmostVisibleCandleCutoff', () => {
  it('uses the rightmost visible candle, clamping right-offset whitespace to the latest candle', () => {
    const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open + 10 * 60_000) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis)).toEqual({
      date: '20260610',
      tMs: day1Open + 120_000,
    });
  });

  it('uses the full rightmost visible candle bucket as the cutoff', () => {
    const candles = [candle(day1Open), candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open + 120_000) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis, 60_000)).toEqual({
      date: '20260610',
      tMs: day1Open + 180_000 - 1,
    });
  });

  it('returns null when the visible range ends before the first loaded candle', () => {
    const candles = [candle(day1Open + 60_000), candle(day1Open + 120_000)];
    const visibleRange: IRange<Time> = {
      from: (axis.toVirtual(day1Open) / 1000) as Time,
      to: (axis.toVirtual(day1Open) / 1000) as Time,
    };

    expect(rightmostVisibleCandleCutoff(candles, visibleRange, axis)).toBeNull();
  });
});

describe('applyPeakVisibleTimeCutoff', () => {
  it('keeps earlier dates full-day, filters the cutoff date, and omits later dates', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 120_000 };

    const out = applyPeakVisibleTimeCutoff([askPeak('20260610'), askPeak('20260611')], cutoff, {
      side: 'ask',
      intraMax: false,
    });

    expect(out).toHaveLength(2);
    expect(out[0].date).toBe('20260610');
    expect(out[0].qty).toBe(100);
    expect(out[1]).toMatchObject({
      date: '20260611',
      price: 100,
      qty: 100,
      t_ms: day2Open + 60_000,
    });
    expect(out[1].untraded_price).toBeNull();
  });

  it('omits the cutoff date when every candidate is after the cutoff', () => {
    const cutoff: VisibleTimeCutoff = { date: '20260611', tMs: day2Open + 30_000 };

    expect(applyPeakVisibleTimeCutoff([askPeak('20260611')], cutoff, {
      side: 'ask',
      intraMax: false,
    })).toEqual([]);
  });

  it('uses bid ranked candidates the same way as ask ranked candidates', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      max_price: 99,
      traded_peaks: [
        { price: 99, qty: 90, t_ms: day2Open + 60_000 },
        { price: 98, qty: 900, t_ms: day2Open + 180_000 },
      ],
      traded_max_peaks: [
        { price: 99, qty: 95, t_ms: day2Open + 60_000 },
        { price: 98, qty: 950, t_ms: day2Open + 180_000 },
      ],
    };

    const out = applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      side: 'bid',
      intraMax: false,
    });

    expect(out).toEqual([expect.objectContaining({ price: 99, qty: 90, t_ms: day2Open + 60_000 })]);
  });

  it('omits bid peaks with explicit empty ranked candidates instead of falling back to full-day fields', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      qty: 900,
      t_ms: day2Open + 180_000,
      max_price: 99,
      max_qty: 900,
      max_t_ms: day2Open + 180_000,
      traded_peaks: [],
      traded_max_peaks: [],
    };

    expect(applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      side: 'bid',
      intraMax: false,
    })).toEqual([]);
  });

  it('filters bid all-price fields independently of traded candidates', () => {
    const bid: BidPeak = {
      ...askPeak('20260611'),
      price: 99,
      max_price: 99,
      traded_peaks: [{ price: 99, qty: 90, t_ms: day2Open + 60_000 }],
      traded_max_peaks: [{ price: 99, qty: 95, t_ms: day2Open + 60_000 }],
      all_price: 97,
      all_qty: 900,
      all_t_ms: day2Open + 180_000,
      all_max_price: 96,
      all_max_qty: 950,
      all_max_t_ms: day2Open + 180_000,
    };

    const out = applyPeakVisibleTimeCutoff([bid], { date: '20260611', tMs: day2Open + 120_000 }, {
      side: 'bid',
      intraMax: false,
    });

    expect(out).toEqual([
      expect.objectContaining({
        price: 99,
        all_price: null,
        all_qty: null,
        all_t_ms: null,
        all_max_price: null,
        all_max_qty: null,
        all_max_t_ms: null,
      }),
    ]);
  });
});
