import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { TradeVolumePocWire } from '../api/types';
import type { ObSnapshot } from './bucketHogaSeries';
import { useLivePageStore } from '../state/livePage';
import { useTradeVolumePocs } from './useTradeVolumePoc';

const KST = 9 * 60 * 60 * 1000;

function atKst(h: number, m: number): number {
  return Date.UTC(2026, 5, 25, h, m) - KST;
}

function book(t_ms: number, continuous: boolean): ObSnapshot {
  const levels = Array.from({ length: 10 }, (_, index) => ({
    price: 100 + index,
    qty: continuous || index < 3 ? 1 : 0,
  }));
  return {
    t_ms,
    total_ask_qty: 10,
    total_bid_qty: 10,
    asks: levels,
    bids: levels,
  };
}

describe('useTradeVolumePocs', () => {
  it('keeps past distribution-bin seeds even when the legacy band setting differs', () => {
    useLivePageStore.setState({
      tradeVolumePocBandPct: 0.01,
      volumeDistributionRangeCount: 10,
    });
    const seeds: TradeVolumePocWire[] = [{
      date: '20260624',
      center_price: 115,
      low_price: 110,
      high_price: 120,
      qty: 20,
      t_ms: 1,
      band_pct: 0.005,
    }];

    const { result } = renderHook(() => useTradeVolumePocs([], seeds, '20260625', '005930'));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      date: '20260624',
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
    });
  });

  it('prefers today live distribution over a persisted today seed', () => {
    useLivePageStore.setState({
      tradeVolumePocBandPct: 0.005,
      volumeDistributionRangeCount: 2,
    });
    const seeds: TradeVolumePocWire[] = [{
      date: '20260625',
      center_price: 105,
      low_price: 100,
      high_price: 110,
      qty: 10,
      t_ms: atKst(9, 1),
      band_pct: 0.005,
    }];

    const { result } = renderHook(() => useTradeVolumePocs(
      [{ t_ms: atKst(9, 2), trades: [{ t_ms: atKst(9, 2), price: 110, qty: 40, side: 1 }] }],
      seeds,
      '20260625',
      '005930',
      [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      [{ date: '20260625', session_open_ms: atKst(9, 0), session_close_ms: atKst(15, 30), source: 'kiwoom_live' as const }],
    ));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      date: '20260625',
      lowPrice: 110,
      highPrice: 120,
      qty: 40,
    });
  });

  it('excludes today live trades at and after the first trailing single-price orderbook', () => {
    useLivePageStore.setState({
      tradeVolumePocBandPct: 0.005,
      volumeDistributionRangeCount: 2,
    });

    const { result } = renderHook(() => useTradeVolumePocs(
      [
        { t_ms: atKst(14, 59), trades: [{ t_ms: atKst(14, 59), price: 110, qty: 20, side: 1 }] },
        { t_ms: atKst(15, 5), trades: [{ t_ms: atKst(15, 5), price: 100, qty: 1_000, side: 1 }] },
      ],
      [],
      '20260625',
      '005930',
      [{ ts_ms: atKst(9, 1), open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      [{ date: '20260625', session_open_ms: atKst(9, 0), session_close_ms: atKst(15, 30), source: 'kiwoom_live' as const }],
      [
        book(atKst(14, 59), true),
        book(atKst(15, 5), false),
      ],
    ));

    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({
      date: '20260625',
      lowPrice: 110,
      highPrice: 120,
      qty: 20,
      t_ms: atKst(14, 59),
    });
  });
});

it('does not read candle prices for dates already covered by a seed', () => {
  useLivePageStore.setState({ volumeDistributionRangeCount: 10 });
  const seeds: TradeVolumePocWire[] = [{ date: '20260624', center_price: 100, low_price: 90, high_price: 110, qty: 20, t_ms: 1, band_pct: 0.005 }];
  const candles = [{ ts_ms: atKst(9, 1) - 86400000, open: 100, get high(): number { throw new Error('unused fallback computed'); }, low: 90, close: 100, vol_a: 10, vol_b: 0 }];
  const segments = [{ date: '20260624', session_open_ms: atKst(9, 0) - 86400000, session_close_ms: atKst(15, 30) - 86400000, source: 'kiwoom_live' as const }];
  const { result, rerender } = renderHook(({ seeds }) => useTradeVolumePocs([], seeds, '20260625', '005930', candles, segments), { initialProps: { seeds } });
  expect(result.current[0].qty).toBe(20);
  rerender({ seeds: [{ ...seeds[0], qty: 30 }] });
  expect(result.current[0].qty).toBe(30);
});

it('retains an unseeded past fallback through a live trade update, then replaces it with a seed', () => {
  useLivePageStore.setState({ volumeDistributionRangeCount: 10 });
  const candles = [{ ts_ms: atKst(9, 1) - 86400000, open: 100, high: 110, low: 90, close: 100, vol_a: 10, vol_b: 0 }];
  const segments = [{ date: '20260624', session_open_ms: atKst(9, 0) - 86400000, session_close_ms: atKst(15, 30) - 86400000, source: 'kiwoom_live' as const }];
  const seeds: TradeVolumePocWire[] = [];
  const trades = [{ t_ms: atKst(9, 2), trades: [{ t_ms: atKst(9, 2), price: 110, qty: 40, side: 1 }] }];
  const { result, rerender } = renderHook(({ trades, seeds }) => useTradeVolumePocs(trades, seeds, '20260625', '005930', candles, segments), { initialProps: { trades, seeds } });
  const past = result.current.find(p => p.date === '20260624');
  expect(past?.qty).toBe(10);
  rerender({ trades: [...trades], seeds });
  expect(result.current.find(p => p.date === '20260624')).toBe(past);
  rerender({ trades, seeds: [{ date: '20260624', center_price: 100, low_price: 90, high_price: 110, qty: 99, t_ms: 1, band_pct: 0.005 }] });
  expect(result.current.find(p => p.date === '20260624')?.qty).toBe(99);
  rerender({ trades, seeds });
  expect(result.current.find(p => p.date === '20260624')?.qty).toBe(10);
});
