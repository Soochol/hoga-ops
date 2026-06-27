import { describe, expect, it } from 'vitest';

import {
  computeContinuousTradeVolumeDistribution,
  mergeVolumeDistributionTail,
  selectVolumeDistributionProfile,
  volumeDistributionClosePoints,
} from './continuousTradeVolumeDistribution';
import type { DayVolumeDistribution } from '../api/types';

const profile = (overrides: Partial<DayVolumeDistribution> = {}): DayVolumeDistribution => ({
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 20 },
  ],
  ...overrides,
});

describe('computeContinuousTradeVolumeDistribution', () => {
  it('merges only continuous live tail trades after last_trade_ms and at or before cursor', () => {
    const selected = mergeVolumeDistributionTail(profile({ last_trade_ms: 90_001_000 }), [
      { t_ms: 90_000_000, price: 105, qty: 999, side: 1 },
      { t_ms: 90_002_000, price: 105, qty: 7, side: 1 },
      { t_ms: 90_003_000, price: 115, qty: 11, side: -1 },
      { t_ms: 90_004_000, price: 115, qty: 999, side: 1 },
      { t_ms: 90_002_000, price: 115, qty: 999, side: 0 },
    ], 90_003_000);

    expect(selected.bins.map((bin) => bin.qty)).toEqual([17, 31]);
    expect(selected.last_trade_ms).toBe(90_003_000);
  });

  it('computes a live fallback distribution only up to cutoffMs', () => {
    const selected = computeContinuousTradeVolumeDistribution({
      date: '20260625',
      candles: [{ ts_ms: 1, open: 100, high: 120, low: 100, close: 110, vol_a: 0, vol_b: 0 }],
      trades: [
        { t_ms: 90_000_000, price: 100, qty: 10, side: 1 },
        { t_ms: 90_001_000, price: 110, qty: 20, side: -1 },
        { t_ms: 90_002_000, price: 120, qty: 30, side: 1 },
      ],
      rangeCount: 2,
      segment: { date: '20260625', session_open_ms: 90_000_000, session_close_ms: 153_000_000 },
      cutoffMs: 90_001_000,
    });

    expect(selected?.bins.map((bin) => bin.qty)).toEqual([10, 20]);
  });

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
    expect(profile?.last_trade_ms).toBe(90_001_000);
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
    expect(profile?.last_trade_ms).toBe(152_999_999);
  });

  it('selects a saved profile for study-style readouts by date only', () => {
    const selected = selectVolumeDistributionProfile({
      enabled: true,
      date: '20260624',
      todayKst: '',
      rangeCount: 2,
      persistedProfiles: [profile({ date: '20260625' }), profile({ date: '20260624' })],
      recomputedToday: null,
      liveTrades: [],
    });

    expect(selected?.date).toBe('20260624');
  });

  it('merges newer live trades into a persisted today profile', () => {
    const selected = selectVolumeDistributionProfile({
      enabled: true,
      date: '20260625',
      todayKst: '20260625',
      rangeCount: 2,
      persistedProfiles: [profile({ last_trade_ms: 90_001_000 })],
      recomputedToday: null,
      liveTrades: [
        { t_ms: 90_000_000, price: 105, qty: 999, side: 1 },
        { t_ms: 90_002_000, price: 105, qty: 7, side: 1 },
        { t_ms: 90_003_000, price: 115, qty: 11, side: -1 },
        { t_ms: 90_004_000, price: 115, qty: 999, side: 0 },
      ],
    });

    expect(selected?.bins.map((bin) => bin.qty)).toEqual([17, 31]);
    expect(selected?.last_trade_ms).toBe(90_003_000);
  });

  it('uses recomputed today profile when persisted bins are empty or range count changed', () => {
    const recomputed = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 50 },
        { price_low: 110, price_high: 120, qty: 70 },
      ],
    });

    expect(selectVolumeDistributionProfile({
      enabled: true,
      date: '20260625',
      todayKst: '20260625',
      rangeCount: 2,
      persistedProfiles: [profile({ last_trade_ms: null, bins: profile().bins.map((bin) => ({ ...bin, qty: 0 })) })],
      recomputedToday: recomputed,
      liveTrades: [],
    })).toBe(recomputed);

    expect(selectVolumeDistributionProfile({
      enabled: true,
      date: '20260625',
      todayKst: '20260625',
      rangeCount: 4,
      persistedProfiles: [profile()],
      recomputedToday: recomputed,
      liveTrades: [],
    })).toBe(recomputed);
  });

  it('returns sorted close points for the selected distribution date', () => {
    const points = volumeDistributionClosePoints({
      date: '20260625',
      candles: [
        { ts_ms: Date.UTC(2026, 5, 24, 0, 1), open: 1, high: 1, low: 1, close: 999, vol_a: 0, vol_b: 0 },
        { ts_ms: Date.UTC(2026, 5, 25, 0, 2), open: 1, high: 1, low: 1, close: 102, vol_a: 0, vol_b: 0 },
        { ts_ms: Date.UTC(2026, 5, 25, 0, 1), open: 1, high: 1, low: 1, close: 101, vol_a: 0, vol_b: 0 },
      ],
    });

    expect(points).toEqual([
      { t_ms: Date.UTC(2026, 5, 25, 0, 1), close: 101 },
      { t_ms: Date.UTC(2026, 5, 25, 0, 2), close: 102 },
    ]);
  });
});
