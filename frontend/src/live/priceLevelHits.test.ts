import { describe, expect, it } from 'vitest';
import type { Candle, PriceLevelHit } from '../api/types';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';

const todayOpen = Date.UTC(2026, 5, 24, 0, 0, 0);
const yesterdayOpen = Date.UTC(2026, 5, 23, 0, 0, 0);

function candle(ts_ms: number, open: number, close = open): Candle {
  return { ts_ms, open, high: open, low: open, close, vol_a: 0, vol_b: 0 };
}

function candleRange(ts_ms: number, open: number, high: number, low: number, close = open): Candle {
  return { ts_ms, open, high, low, close, vol_a: 0, vol_b: 0 };
}

describe('priceLevelHits', () => {
  it('builds live VI and limit hits from candle high/low touches', () => {
    const candles = [
      candle(yesterdayOpen + 60_000, 9_700, 10_000),
      candleRange(todayOpen + 60_000, 10_000, 10_900, 9_500),
      candleRange(todayOpen + 120_000, 10_800, 11_100, 10_700),
      candleRange(todayOpen + 180_000, 11_500, 12_100, 11_400),
      candleRange(todayOpen + 240_000, 12_000, 13_100, 11_900),
      candleRange(todayOpen + 300_000, 12_500, 12_600, 6_900),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
      ['vi', 'lower', 10, 9_000, todayOpen + 300_000],
      ['limit', 'upper', 30, 13_000, todayOpen + 240_000],
      ['limit', 'lower', 30, 7_000, todayOpen + 300_000],
    ]);
  });

  it('keeps the first candle that touches a level', () => {
    const candles = [
      candleRange(todayOpen + 60_000, 10_000, 10_999, 9_900),
      candleRange(todayOpen + 120_000, 10_900, 11_001, 10_800),
      candleRange(todayOpen + 180_000, 11_000, 11_500, 10_900),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
    ]);
  });

  it('uses the first post-VI cooling candle open as the second VI basis', () => {
    const candles = [
      candleRange(todayOpen, 10_000, 10_500, 9_500),
      candleRange(todayOpen + 60_000, 10_500, 11_000, 10_400),
      candleRange(todayOpen + 120_000, 11_000, 11_100, 10_900),
      candleRange(todayOpen + 180_000, 11_500, 12_600, 11_400),
      candleRange(todayOpen + 240_000, 12_500, 12_700, 12_400),
      candleRange(todayOpen + 300_000, 12_650, 12_700, 9_000),
      candleRange(todayOpen + 360_000, 9_000, 9_100, 8_800),
      candleRange(todayOpen + 420_000, 8_500, 8_600, 7_900),
      candleRange(todayOpen + 480_000, 8_000, 8_100, 7_650),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 60_000],
      ['vi', 'upper', 20, 12_650, todayOpen + 240_000],
      ['vi', 'lower', 10, 9_000, todayOpen + 300_000],
      ['vi', 'lower', 20, 7_650, todayOpen + 480_000],
    ]);
  });

  it('uses KRX tick-adjusted trigger prices instead of raw rounded percentages', () => {
    const candles = [
      candle(yesterdayOpen + 60_000, 23_000, 24_200),
      candleRange(todayOpen + 60_000, 29_100, 32_060, 29_000),
      candleRange(todayOpen + 120_000, 32_000, 32_010, 26_140),
      candleRange(todayOpen + 180_000, 26_200, 31_460, 26_100),
    ];

    const hits = buildLivePriceLevelHits(candles, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 32_050, todayOpen + 60_000],
      ['vi', 'upper', 20, 28_850, todayOpen + 180_000],
      ['vi', 'lower', 10, 26_150, todayOpen + 120_000],
      ['limit', 'upper', 30, 31_450, todayOpen + 60_000],
    ]);
  });

  it('dedupes backend and live hits by date price kind direction pct', () => {
    const backend: PriceLevelHit[] = [{
      date: '20260624',
      t_ms: todayOpen + 60_000,
      price: 11_000,
      kind: 'vi',
      direction: 'upper',
      pct: 10,
    }];
    const live: PriceLevelHit[] = [{
      ...backend[0],
      t_ms: todayOpen + 120_000,
    }];

    expect(mergePriceLevelHits(backend, live)).toEqual(backend);
  });
});
