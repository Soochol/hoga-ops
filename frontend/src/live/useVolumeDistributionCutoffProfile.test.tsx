import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DayVolumeDistribution, RangeBundle } from '../api/types';
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
      sourcePref: 'hogaplay',
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
      sourcePref: 'hogaplay',
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
});
