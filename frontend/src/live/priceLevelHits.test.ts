import { describe, expect, it } from 'vitest';
import type { Candle, PriceLevelHit } from '../api/types';
import type { TradeSnapshot } from './bucketHogaSeries';
import { buildLivePriceLevelHits, mergePriceLevelHits } from './priceLevelHits';

const todayOpen = Date.UTC(2026, 5, 24, 0, 0, 0);
const yesterdayOpen = Date.UTC(2026, 5, 23, 0, 0, 0);

function candle(ts_ms: number, open: number, close = open): Candle {
  return { ts_ms, open, high: open, low: open, close, vol_a: 0, vol_b: 0 };
}

function trade(t_ms: number, price: number): TradeSnapshot {
  return { t_ms, trades: [{ t_ms, price, qty: 1, side: 1 }] };
}

describe('priceLevelHits', () => {
  it('builds live VI hits from today open and limit hits from previous close', () => {
    const candles = [
      candle(yesterdayOpen + 60_000, 9_700, 10_000),
      candle(todayOpen + 60_000, 10_000),
    ];
    const trades = [
      trade(todayOpen + 120_000, 11_000),
      trade(todayOpen + 180_000, 12_000),
      trade(todayOpen + 240_000, 13_000),
      trade(todayOpen + 300_000, 7_000),
    ];

    const hits = buildLivePriceLevelHits(candles, trades, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
      ['vi', 'upper', 20, 12_000, todayOpen + 180_000],
      ['limit', 'upper', 30, 13_000, todayOpen + 240_000],
      ['limit', 'lower', 30, 7_000, todayOpen + 300_000],
    ]);
  });

  it('requires exact trade price and keeps the first hit per level', () => {
    const candles = [candle(todayOpen + 60_000, 10_000)];
    const trades = [
      trade(todayOpen + 90_000, 10_999),
      trade(todayOpen + 120_000, 11_000),
      trade(todayOpen + 180_000, 11_000),
    ];

    const hits = buildLivePriceLevelHits(candles, trades, '20260624');

    expect(hits.map((h) => [h.kind, h.direction, h.pct, h.price, h.t_ms])).toEqual([
      ['vi', 'upper', 10, 11_000, todayOpen + 120_000],
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
