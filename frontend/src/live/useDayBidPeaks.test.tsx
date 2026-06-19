import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayBidPeaks } from './useDayBidPeaks';
import type { BidPeak, Candle } from '../api/types';
import type { LiveTodayBidPeak } from '../api/liveSeries';
import type { ObSnapshot, TradeSnapshot } from './bucketHogaSeries';

const deep = (
  t_ms: number,
  levels: Array<[number, number]>,
): ObSnapshot => ({
  t_ms,
  total_ask_qty: 0,
  total_bid_qty: 0,
  asks: Array.from({ length: 10 }, (_, i) => ({ price: 25000 + i, qty: 100 })),
  bids: levels.map(([price, qty]) => ({ price, qty })),
});

const byDate = (peaks: readonly BidPeak[]) => Object.fromEntries(peaks.map((p) => [p.date, p]));
const atKst = (hh: number, mm = 0) => Date.UTC(2026, 5, 13, hh - 9, mm);
const candle = (t_ms: number, low: number, high: number): Candle => ({
  ts_ms: t_ms,
  open: high,
  high,
  low,
  close: low,
  vol_a: 1,
  vol_b: 0,
});
const trade = (t_ms: number, trades: TradeSnapshot['trades']): TradeSnapshot => ({ t_ms, trades });

const todayBidPeak = (overrides: Partial<LiveTodayBidPeak> = {}): LiveTodayBidPeak => ({
  date: '20260613',
  coverage: 'partial',
  traded_prices: [23900],
  traded_price: 23900,
  traded_qty: 9000,
  traded_t_ms: atKst(9, 10),
  all_price: 23800,
  all_qty: 12000,
  all_t_ms: atKst(9, 11),
  ...overrides,
});

describe('useDayBidPeaks', () => {
  it('only promotes traded bid prices, even when a larger untraded wall exists', () => {
    const { result } = renderHook(() => useDayBidPeaks(
      [
        deep(atKst(9, 21), [
          [23850, 15000],
          [23900, 9000],
          ...Array(8).fill([1, 1]),
        ] as Array<[number, number]>),
      ],
      [trade(atKst(9, 20), [{ t_ms: atKst(9, 20), side: 1, price: 23900, qty: 10 }])],
      [],
      '20260613',
      '005930',
    ));

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23900,
      qty: 9000,
      t_ms: atKst(9, 21),
    });
  });

  it('promotes REST all-price bid peaks when the price falls inside a today candle range', () => {
    const restPeak = todayBidPeak({
      traded_prices: [],
      traded_price: null,
      traded_qty: null,
      traded_t_ms: null,
      all_price: 23800,
      all_qty: 12000,
      all_t_ms: atKst(10, 42),
    });

    const { result } = renderHook(() => useDayBidPeaks(
      [],
      [],
      [],
      '20260613',
      '005930',
      restPeak,
      [candle(atKst(10, 42), 23700, 23900)],
    ));

    expect(byDate(result.current)['20260613']).toEqual({
      date: '20260613',
      price: 23800,
      qty: 12000,
      t_ms: atKst(10, 42),
      max_price: 23800,
      max_qty: 12000,
      max_t_ms: atKst(10, 42),
    });
  });

  it('retroactively promotes a previously observed bid wall once that price trades later', () => {
    const { result, rerender } = renderHook(
      ({ ob, trades }: { ob: ObSnapshot[]; trades: TradeSnapshot[] }) =>
        useDayBidPeaks(ob, trades, [], '20260613', '005930'),
      { initialProps: { ob: [] as ObSnapshot[], trades: [] as TradeSnapshot[] } },
    );

    rerender({
      trades: [],
      ob: [deep(atKst(9, 20), [[23800, 20000], ...Array(9).fill([1, 1])] as Array<[number, number]>)],
    });
    expect(result.current.find((p) => p.date === '20260613')).toBeUndefined();

    rerender({
      trades: [trade(atKst(9, 21), [{ t_ms: atKst(9, 21), side: 1, price: 23800, qty: 10 }])],
      ob: [deep(atKst(9, 20), [[23800, 20000], ...Array(9).fill([1, 1])] as Array<[number, number]>)],
    });

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23800,
      qty: 20000,
      t_ms: atKst(9, 20),
    });
  });
});
