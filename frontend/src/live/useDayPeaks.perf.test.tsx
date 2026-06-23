import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useDayAskPeaks } from './useDayAskPeaks';
import { useDayBidPeaks } from './useDayBidPeaks';
import type { Candle } from '../api/types';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const base = Date.UTC(2026, 5, 23, 0, 0, 0);

const candles: Candle[] = Array.from({ length: 2500 }, (_, i) => ({
  ts_ms: base + (i % 300) * 60_000,
  open: 20_000 + i * 10,
  high: 20_005 + i * 10,
  low: 20_000 + i * 10,
  close: 20_005 + i * 10,
  vol_a: 0,
  vol_b: 0,
}));

const ob: ObSnapshot[] = Array.from({ length: 2000 }, (_, i) => ({
  t_ms: base + i * 1000,
  total_ask_qty: 1000 + i,
  total_bid_qty: 900 + i,
  asks: Array.from({ length: 10 }, (_unused, level) => ({
    price: 40_000 + level,
    qty: 100 + i + level,
  })),
  bids: Array.from({ length: 10 }, (_unused, level) => ({
    price: 40_000 + level,
    qty: 120 + i + level,
  })),
}));

const trade: TradeSnapshot[] = Array.from({ length: 2000 }, (_, i) => ({
  t_ms: base + i * 1000,
  trades: [{ side: i % 2 === 0 ? 1 : -1, price: 40_000 + (i % 10), qty: 1 }],
}));

describe('live day peak performance', () => {
  it('processes large live buffers without second-scale stalls', () => {
    const started = performance.now();
    renderHook(() => useDayAskPeaks(ob, trade, [], '20260623', '005930', null, candles));
    renderHook(() => useDayBidPeaks(ob, trade, [], '20260623', '005930', null, candles));
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });
});
