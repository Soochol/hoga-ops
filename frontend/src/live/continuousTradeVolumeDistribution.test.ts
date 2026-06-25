import { describe, expect, it } from 'vitest';

import { computeContinuousTradeVolumeDistribution } from './continuousTradeVolumeDistribution';

describe('computeContinuousTradeVolumeDistribution', () => {
  it('bins side +/-1 trades and excludes side 0', () => {
    const profile = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      trades: [
        { t_ms: 90_000_000, price: 100, qty: 10, side: 1 },
        { t_ms: 90_001_000, price: 110, qty: 20, side: -1 },
        { t_ms: 90_002_000, price: 120, qty: 30, side: 0 },
      ],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    });

    expect(profile?.bins.map((bin) => bin.qty)).toEqual([10, 20]);
  });

  it('folds a high-price trade into the last bin', () => {
    const profile = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 120, vol_a: 0, vol_b: 0 }],
      trades: [{ t_ms: 90_000_000, price: 120, qty: 33, side: 1 }],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    });

    expect(profile?.bins.map((bin) => bin.qty)).toEqual([0, 33]);
  });

  it('excludes trades stamped exactly at session_close_ms', () => {
    const profile = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      trades: [
        { t_ms: 152_999_999, price: 100, qty: 10, side: 1 },
        { t_ms: 153_000_000, price: 110, qty: 20, side: 1 },
      ],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
    });

    expect(profile?.bins.map((bin) => bin.qty)).toEqual([10, 0]);
  });
});
