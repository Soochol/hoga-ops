import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDayBidPeaks, useTodayAllPriceBidPeak } from './useDayBidPeaks';
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
        deep(atKst(9, 20), [
          [23850, 15000],
          [23900, 9000],
          ...Array(8).fill([1, 1]),
        ] as Array<[number, number]>),
      ],
      [trade(atKst(9, 21), [{ t_ms: atKst(9, 21), side: 1, price: 23900, qty: 10 }])],
      [],
      '20260613',
      '005930',
    ));

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23900,
      qty: 9000,
      t_ms: atKst(9, 20),
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

    expect(byDate(result.current)['20260613']).toBeUndefined();
  });

  it('preserves REST traded bid candidates for current-day cutoff recalculation', () => {
    const restPeak = todayBidPeak({
      traded_price: 23800,
      traded_qty: 20000,
      traded_t_ms: atKst(10, 0),
      traded_peaks: [
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
        { price: 23600, qty: 7000, t_ms: atKst(9, 30) },
      ],
    });

    const { result } = renderHook(() => useDayBidPeaks(
      [],
      [],
      [],
      '20260613',
      '005930',
      restPeak,
    ));

    expect(byDate(result.current)['20260613']).toMatchObject({
      price: 23800,
      traded_peaks: [
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
      ],
    });
  });

  it('splits touched and untouched same-price bid walls into separate candidate families', () => {
    const { result } = renderHook(() => useDayBidPeaks(
      [
        deep(atKst(9, 10), [[23900, 1200], ...Array(9).fill([1, 1])] as Array<[number, number]>),
        deep(atKst(9, 12), [[23900, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>),
      ],
      [trade(atKst(9, 11), [{ t_ms: atKst(9, 11), side: 1, price: 23900, qty: 10 }])],
      [],
      '20260613',
      '005930',
    ));

    const today = byDate(result.current)['20260613'];
    expect(today).toMatchObject({
      price: 23900,
      qty: 1200,
      t_ms: atKst(9, 10),
      untraded_price: 23900,
      untraded_qty: 9000,
      untraded_t_ms: atKst(9, 12),
    });
    expect(today.traded_peaks).toEqual(
      expect.arrayContaining([{ price: 23900, qty: 1200, t_ms: atKst(9, 10) }]),
    );
    expect(today.untraded_peaks).toEqual(
      expect.arrayContaining([{ price: 23900, qty: 9000, t_ms: atKst(9, 12) }]),
    );
    expect(today.all_peaks?.slice(0, 2)).toEqual([
      { price: 23900, qty: 9000, t_ms: atKst(9, 12) },
      { price: 23900, qty: 1200, t_ms: atKst(9, 10) },
    ]);
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

  it('keeps live bid peak updates responsive with many candles and repeated prices', () => {
    const base = Date.UTC(2026, 5, 13, 0, 0, 0);
    const candles = Array.from({ length: 2500 }, (_, i) =>
      candle(base + (i % 300) * 60_000, 20_000 + i * 10, 20_005 + i * 10),
    );
    const ob = Array.from({ length: 2000 }, (_, i): ObSnapshot => ({
      t_ms: base + i * 1000,
      total_ask_qty: 1,
      total_bid_qty: 1,
      asks: Array.from({ length: 10 }, (_unused, level) => ({
        price: 41_000 + level,
        qty: 100 + i + level,
      })),
      bids: Array.from({ length: 10 }, (_unused, level) => ({
        price: 40_000 + level,
        qty: 100 + i + level,
      })),
    }));

    const started = performance.now();
    renderHook(() =>
      useDayBidPeaks(ob, [], [], '20260613', '005930', null, candles),
    );
    const elapsed = performance.now() - started;

    expect(elapsed).toBeLessThan(500);
  });
});

describe('useTodayAllPriceBidPeak', () => {
  it('uses REST all-price seed ahead of historical today seed', () => {
    const seed: BidPeak = {
      date: '20260613',
      price: 23900,
      qty: 5000,
      t_ms: atKst(9, 5),
      max_price: 23900,
      max_qty: 5000,
      max_t_ms: atKst(9, 5),
    };

    const { result } = renderHook(() => useTodayAllPriceBidPeak(
      [],
      [seed],
      '20260613',
      '005930',
      todayBidPeak({ all_price: 23800, all_qty: 12000, all_t_ms: atKst(9, 11) }),
    ));

    expect(result.current).toMatchObject({
      date: '20260613',
      price: 23800,
      qty: 12000,
      t_ms: atKst(9, 11),
      max_price: 23800,
      max_qty: 12000,
      max_t_ms: atKst(9, 11),
      all_peaks: [{ price: 23800, qty: 12000, t_ms: atKst(9, 11) }],
    });
  });

  it('falls back to historical today seed when REST today peak is absent', () => {
    const seed: BidPeak = {
      date: '20260613',
      price: 23900,
      qty: 5000,
      t_ms: atKst(9, 5),
      max_price: 23900,
      max_qty: 5000,
      max_t_ms: atKst(9, 5),
    };

    const { result } = renderHook(() => useTodayAllPriceBidPeak(
      [],
      [seed],
      '20260613',
      '005930',
      null,
    ));

    expect(result.current).toMatchObject({
      ...seed,
      all_peaks: [{ price: 23900, qty: 5000, t_ms: atKst(9, 5) }],
    });
  });

  it('ratchets larger live bid walls and resets on code/date changes', () => {
    const first = deep(
      atKst(9, 20),
      [[23800, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>,
    );
    const larger = deep(
      atKst(9, 21),
      [[23700, 15000], ...Array(9).fill([1, 1])] as Array<[number, number]>,
    );

    const { result, rerender } = renderHook(
      ({ ob, todayKst, code }: { ob: ObSnapshot[]; todayKst: string; code: string }) =>
        useTodayAllPriceBidPeak(ob, [], todayKst, code, null),
      { initialProps: { ob: [] as ObSnapshot[], todayKst: '20260613', code: '005930' } },
    );

    expect(result.current).toBeNull();

    rerender({ ob: [first], todayKst: '20260613', code: '005930' });
    expect(result.current).toMatchObject({ price: 23800, qty: 9000, t_ms: atKst(9, 20) });

    rerender({ ob: [first, larger], todayKst: '20260613', code: '005930' });
    expect(result.current).toMatchObject({ price: 23700, qty: 15000, t_ms: atKst(9, 21) });

    rerender({ ob: [], todayKst: '20260614', code: '000660' });
    expect(result.current).toBeNull();
  });

  it('preserves REST all-price bid candidates for current-day cutoff recalculation', () => {
    const restPeak = todayBidPeak({
      all_price: 23800,
      all_qty: 20000,
      all_t_ms: atKst(10, 0),
      all_peaks: [
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
        { price: 23600, qty: 7000, t_ms: atKst(9, 30) },
      ],
    });

    const { result } = renderHook(() => useTodayAllPriceBidPeak(
      [],
      [],
      '20260613',
      '005930',
      restPeak,
    ));

    expect(result.current).toMatchObject({
      price: 23800,
      all_peaks: [
        { price: 23800, qty: 20000, t_ms: atKst(10, 0) },
        { price: 23900, qty: 9000, t_ms: atKst(9, 10) },
        { price: 23700, qty: 8000, t_ms: atKst(9, 20) },
      ],
    });
  });

  it('live all-price bid candidates keep earlier same-price observations for cutoff recalculation', () => {
    const { result } = renderHook(() => useTodayAllPriceBidPeak(
      [
        deep(atKst(9, 11), [[23900, 1200], ...Array(9).fill([1, 1])] as Array<[number, number]>),
        deep(atKst(9, 12), [[23900, 9000], ...Array(9).fill([1, 1])] as Array<[number, number]>),
      ],
      [],
      '20260613',
      '005930',
    ));

    expect(result.current).toMatchObject({ price: 23900, qty: 9000 });
    expect(result.current?.all_peaks?.slice(0, 2)).toEqual([
      { price: 23900, qty: 9000, t_ms: atKst(9, 12) },
      { price: 23900, qty: 1200, t_ms: atKst(9, 11) },
    ]);
  });

  it('all-price hook keeps legacy rank-1 untraded fields when untraded arrays are absent', () => {
    const restPeak = todayBidPeak({
      untraded_price: 23700,
      untraded_qty: 13000,
      untraded_t_ms: atKst(10, 5),
      untraded_max_price: 23700,
      untraded_max_qty: 13000,
      untraded_max_t_ms: atKst(10, 5),
    });

    const { result } = renderHook(
      () => useTodayAllPriceBidPeak([], [], '20260613', '005930', restPeak),
    );

    expect(result.current).toMatchObject({
      untraded_price: 23700,
      untraded_qty: 13000,
      untraded_t_ms: atKst(10, 5),
      untraded_max_price: 23700,
      untraded_max_qty: 13000,
      untraded_max_t_ms: atKst(10, 5),
      untraded_peaks: [{ price: 23700, qty: 13000, t_ms: atKst(10, 5) }],
      untraded_max_peaks: [{ price: 23700, qty: 13000, t_ms: atKst(10, 5) }],
    });
  });
});
