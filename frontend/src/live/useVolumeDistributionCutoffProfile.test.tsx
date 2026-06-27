import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Candle, DayVolumeDistribution, RangeBundle, RangeSegment } from '../api/types';
import { useRange } from '../api/range';
import { useVolumeDistributionCutoffProfile } from './useVolumeDistributionCutoffProfile';

vi.mock('../api/range', async () => {
  const actual = await vi.importActual<typeof import('../api/range')>('../api/range');
  return {
    ...actual,
    useRange: vi.fn(),
  };
});

const mockedUseRange = vi.mocked(useRange);

const profile = (overrides: Partial<DayVolumeDistribution> = {}): DayVolumeDistribution => ({
  date: '20260625',
  range_count: 2,
  price_min: 100,
  price_max: 120,
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
  last_trade_ms: 90_001_000,
  bins: [
    { price_low: 100, price_high: 110, qty: 10 },
    { price_low: 110, price_high: 120, qty: 20 },
  ],
  ...overrides,
});

const emptyBundle: RangeBundle = {
  code: '005930',
  from_date: '20260625',
  to_date: '20260625',
  bucket_ms: 60_000,
  segments: [],
  candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

const segment: RangeSegment = {
  date: '20260625',
  session_open_ms: 90_000_000,
  session_close_ms: 153_000_000,
};

const candles: Candle[] = [
  {
    ts_ms: 90_000_000,
    open: 100,
    high: 120,
    low: 100,
    close: 110,
    vol_a: 0,
    vol_b: 0,
  },
];

describe('useVolumeDistributionCutoffProfile', () => {
  beforeEach(() => {
    mockedUseRange.mockReset();
  });

  it('returns final profile when hover cutoff is disabled', () => {
    mockedUseRange.mockReturnValue({ data: undefined, isLoading: false } as ReturnType<typeof useRange>);
    const finalProfile = profile();

    const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: false,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs: 90_001_000,
      todayKst: null,
      rangeCount: 2,
      finalProfile,
      priceRange: null,
    }));

    expect(result.current).toBe(finalProfile);
  });

  it('requests a single-date sidecar and returns the cutoff profile', () => {
    const cutoffProfile = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 7 },
        { price_low: 110, price_high: 120, qty: 0 },
      ],
    });
    mockedUseRange.mockReturnValue({
      data: { ...emptyBundle, volume_distributions: [cutoffProfile] },
      isLoading: false,
    } as ReturnType<typeof useRange>);

    const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs: 90_001_000,
      todayKst: null,
      rangeCount: 2,
      finalProfile: profile(),
      priceRange: null,
    }));

    expect(mockedUseRange).toHaveBeenCalledWith('005930', '20260625', '20260625', '1m', undefined, null, {
      mode: 'sidecar',
      volumeDistributionBins: 2,
      volumeDistributionCutoffMs: 90_001_000,
      volumeDistributionPriceRange: null,
    });
    expect(result.current).toBe(cutoffProfile);
  });

  it('keeps the previous cutoff profile while the next hover cutoff request is loading', () => {
    const finalProfile = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 100 },
        { price_low: 110, price_high: 120, qty: 200 },
      ],
    });
    const firstCutoffProfile = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 7 },
        { price_low: 110, price_high: 120, qty: 0 },
      ],
    });
    let cursorMs = 90_001_000;
    mockedUseRange.mockImplementation(() => {
      if (cursorMs === 90_001_000) {
        return {
          data: { ...emptyBundle, volume_distributions: [firstCutoffProfile] },
          isFetching: false,
        } as ReturnType<typeof useRange>;
      }
      return {
        data: undefined,
        isFetching: true,
      } as ReturnType<typeof useRange>;
    });

    const { result, rerender } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs,
      todayKst: null,
      rangeCount: 2,
      finalProfile,
      priceRange: null,
    }));

    expect(result.current).toBe(firstCutoffProfile);

    cursorMs = 90_002_000;
    rerender();

    expect(result.current).toBe(firstCutoffProfile);
  });

  it('keeps the previous cutoff profile when the next hover cutoff query has no data yet', () => {
    const finalProfile = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 100 },
        { price_low: 110, price_high: 120, qty: 200 },
      ],
    });
    const firstCutoffProfile = profile({
      bins: [
        { price_low: 100, price_high: 110, qty: 7 },
        { price_low: 110, price_high: 120, qty: 0 },
      ],
    });
    let cursorMs = 90_001_000;
    mockedUseRange.mockImplementation(() => {
      if (cursorMs === 90_001_000) {
        return {
          data: { ...emptyBundle, volume_distributions: [firstCutoffProfile] },
          isFetching: false,
        } as ReturnType<typeof useRange>;
      }
      return {
        data: undefined,
        isFetching: false,
      } as ReturnType<typeof useRange>;
    });

    const { result, rerender } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs,
      todayKst: null,
      rangeCount: 2,
      finalProfile,
      priceRange: null,
    }));

    expect(result.current).toBe(firstCutoffProfile);

    cursorMs = 90_002_000;
    rerender();

    expect(result.current).toBe(firstCutoffProfile);
  });

  it('merges valid live-edge trades after a sidecar cutoff profile', () => {
    const cutoffProfile = profile({ last_trade_ms: 90_001_000 });
    mockedUseRange.mockReturnValue({
      data: { ...emptyBundle, volume_distributions: [cutoffProfile] },
      isLoading: false,
    } as ReturnType<typeof useRange>);

    const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs: 90_003_000,
      todayKst: '20260625',
      rangeCount: 2,
      finalProfile: profile(),
      priceRange: null,
      liveTrades: [
        { t_ms: 90_002_000, price: 115, qty: 5, side: 1 },
        { t_ms: 90_004_000, price: 105, qty: 99, side: 1 },
      ],
    }));

    expect(result.current).toEqual({
      ...cutoffProfile,
      last_trade_ms: 90_002_000,
      bins: [
        { price_low: 100, price_high: 110, qty: 10 },
        { price_low: 110, price_high: 120, qty: 25 },
      ],
    });
  });

  it('keeps final profile when fallback recompute has no valid live trades', () => {
    mockedUseRange.mockReturnValue({
      data: emptyBundle,
      isLoading: false,
    } as ReturnType<typeof useRange>);
    const finalProfile = profile();

    const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: '005930',
      timeframe: '1m',
      date: '20260625',
      cursorMs: 90_001_000,
      todayKst: '20260625',
      rangeCount: 2,
      finalProfile,
      priceRange: null,
      candles,
      segment,
      liveTrades: [
        { t_ms: 90_001_000, price: 115, qty: 10, side: 0 },
        { t_ms: 90_001_000, price: 125, qty: 10, side: 1 },
      ],
    }));

    expect(result.current).toBe(finalProfile);
  });

  it('returns final profile and sends no cutoff request when required inputs are invalid', () => {
    mockedUseRange.mockReturnValue({ data: undefined, isLoading: false } as ReturnType<typeof useRange>);
    const finalProfile = profile();

    const { result } = renderHook(() => useVolumeDistributionCutoffProfile({
      enabled: true,
      code: null,
      timeframe: '1m',
      date: '20260625',
      cursorMs: 90_001_000,
      todayKst: '20260625',
      rangeCount: 2,
      finalProfile,
      priceRange: null,
    }));

    expect(mockedUseRange).toHaveBeenCalledWith(null, null, null, null, undefined, '20260625', {
      mode: 'sidecar',
      volumeDistributionBins: 2,
      volumeDistributionCutoffMs: null,
      volumeDistributionPriceRange: null,
    });
    expect(result.current).toBe(finalProfile);
  });
});
