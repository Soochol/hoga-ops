import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import { LIVE_SETTINGS_KEY } from '../api/liveSettings';
import type { StudyViewReference } from '../api/studyViews';
import type { RangeBundle } from '../api/types';

const {
  useQueryMock,
  studyReferenceQueryOptionsMock,
  useScreenerDailyCandlesMock,
} = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  studyReferenceQueryOptionsMock: vi.fn(),
  useScreenerDailyCandlesMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: useQueryMock,
  };
});

vi.mock('./studyReferenceQueries', () => ({
  studyReferenceQueryOptions: studyReferenceQueryOptionsMock,
}));

vi.mock('../api/screenerDailyCandles', () => ({
  useScreenerDailyCandles: useScreenerDailyCandlesMock,
}));

import { useLivePageStore } from '../state/livePage';
import { useLiveVenueStore } from '../state/liveVenue';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';

const save: StudyViewReference = {
  schema_version: 2,
  id: 'ref1',
  name: '복기',
  code: '005930',
  label: '삼성전자',
  timeframe: '5m',
  range: { from_date: '20260616', to_date: '20260618', from_ms: 1_000, to_ms: 2_000 },
  viewport: { right_edge_ms: 2_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
};
const minuteSave: StudyViewReference = {
  ...save,
  range: {
    from_date: '20260616',
    to_date: '20260618',
    from_ms: 1_781_568_000_000,
    to_ms: 1_781_568_300_000,
  },
};
const dailySave: StudyViewReference = {
  ...save,
  timeframe: 'D',
  range: {
    from_date: '20260616',
    to_date: '20260618',
    from_ms: 1_781_568_000_000,
    to_ms: 1_781_741_100_000,
  },
};

const rangeHogaOptions = { queryKey: ['range-hoga-plan'], enabled: true } as unknown as UseQueryOptions;
const rangeSidecarOptions = { queryKey: ['range-sidecar-plan'], enabled: true } as unknown as UseQueryOptions;
const minuteOptions = { queryKey: ['minute-plan'], enabled: true } as unknown as UseQueryOptions;
const dailyOptions = { queryKey: ['daily-plan'], enabled: false } as unknown as UseQueryOptions;
let kisRestBypassEnabled = false;
let rangeCandlesFixture: Array<{ ts_ms: number; open: number; high: number; low: number; close: number; vol_a: number; vol_b: number }> = [];
let screenerDailyCandlesFixture: Array<{ t_ms: number; open: number; high: number; low: number; close: number; volume: number }> = [];

function rangeBundleFixture(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260618',
    bucket_ms: 300_000,
    segments: [
      { date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000, source: 'hogaplay' },
    ],
    candles: [],
    quote_ratio: { bucket_ms: 300_000, points: [] },
    fill_strength: { bucket_ms: 300_000, points: [] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    price_level_hits: [],
    trade_volume_pocs: [],
    program_trade: { points: [] },
    ...overrides,
  };
}

function queryResultFor(options: UseQueryOptions): Partial<UseQueryResult> {
  if (Array.isArray(options.queryKey) && options.queryKey.length === LIVE_SETTINGS_KEY.length &&
    options.queryKey.every((value, index) => value === LIVE_SETTINGS_KEY[index])) {
    return {
      data: {
        schema_version: 1,
        storage_policy: 'ws_plus_rest',
        program_trade_storage_enabled: false,
        kis_rest_bypass_enabled: kisRestBypassEnabled,
      },
      isLoading: false,
      error: null,
    };
  }
  if (options === rangeHogaOptions) {
    return { data: null, isLoading: false, error: null };
  }
  if (options === rangeSidecarOptions) {
    return { data: null, isLoading: false, error: null };
  }
  if (Array.isArray(options.queryKey) && options.queryKey[0] === 'range' && options.queryKey[14] === 'candles') {
    return {
      data: rangeCandlesFixture.length > 0 ? rangeBundleFixture({
        bucket_ms: 180_000,
        candles: rangeCandlesFixture,
      }) : null,
      isLoading: false,
      error: null,
    };
  }
  if (options === minuteOptions) {
    return {
      data: { candles: [], data_warnings: ['minute-warning'], effective_sessions: [] },
      isLoading: false,
      error: null,
    };
  }
  if (options === dailyOptions) {
    return {
      data: { candles: [], data_warnings: ['daily-warning'] },
      isLoading: false,
      error: null,
    };
  }
  return { data: null, isLoading: false, error: null };
}

describe('useStudyReferenceBundle', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    studyReferenceQueryOptionsMock.mockReset();
    studyReferenceQueryOptionsMock.mockReturnValue({
      rangeHoga: rangeHogaOptions,
      rangeSidecars: rangeSidecarOptions,
      minuteCandles: minuteOptions,
      dailyCandles: dailyOptions,
    });
    kisRestBypassEnabled = false;
    rangeCandlesFixture = [];
    screenerDailyCandlesFixture = [];
    useQueryMock.mockImplementation(queryResultFor);
    useScreenerDailyCandlesMock.mockImplementation(() => ({
      data: { candles: screenerDailyCandlesFixture, data_warnings: [] },
      isLoading: false,
      error: null,
    }));
    useLiveVenueStore.setState({ venue: 'NXT' });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_api_first' });
    useLivePageStore.setState({
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('uses the shared study reference query plan for the active 복기뷰', () => {
    renderHook(() => useStudyReferenceBundle(save));

    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(save, {
      venue: 'NXT',
      sourcePref: 'kis_api_first',
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
    expect(useQueryMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      queryKey: LIVE_SETTINGS_KEY,
    }));
    expect(useQueryMock).toHaveBeenNthCalledWith(2, rangeHogaOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(3, rangeSidecarOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(4, expect.objectContaining({
      queryKey: ['range', '005930', '20260616', '20260618', 300000, undefined, undefined, false, null, null, undefined, undefined, null, 'kis_api_first', 'candles', null],
    }));
    expect(useQueryMock).toHaveBeenNthCalledWith(5, minuteOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(6, dailyOptions);
  });

  it('uses lightweight range candle fallback for minute study when KIS REST bypass is enabled', () => {
    kisRestBypassEnabled = true;
    rangeCandlesFixture = [{ ts_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, vol_a: 100, vol_b: 0 }];

    const { result } = renderHook(() => useStudyReferenceBundle(minuteSave));

    expect(result.current.bundle?.candles).toHaveLength(1);
    expect(useQueryMock).toHaveBeenCalledWith(expect.objectContaining({
      queryKey: ['range', '005930', '20260616', '20260618', 300000, undefined, undefined, false, null, null, undefined, undefined, null, 'kis_api_first', 'candles', null],
    }));
  });

  it('uses screener daily fallback for stock D/W/M study when KIS REST bypass is enabled', () => {
    kisRestBypassEnabled = true;
    screenerDailyCandlesFixture = [{ t_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, volume: 100 }];
    const { result } = renderHook(() => useStudyReferenceBundle(dailySave));

    expect(result.current.bundle?.candles).toHaveLength(1);
    expect(useScreenerDailyCandlesMock).toHaveBeenCalledWith('005930', '20260616', '20260618');
  });

  it('merges sidecar overlays into the hoga study bundle without waiting on sidecar loading', () => {
    const broker = { t_ms: 1_779_840_000_000, broker: 'NH투자증권', side: 'buy' as const, net: 42 };
    const distribution = {
      date: '20260618',
      range_count: 1,
      price_min: 69900,
      price_max: 70100,
      session_open_ms: 1_779_840_000_000,
      session_close_ms: 1_779_863_400_000,
      bins: [{ price_low: 69900, price_high: 70100, qty: 123 }],
    };
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeHogaOptions) {
        return {
          data: rangeBundleFixture({
            quote_ratio: {
              bucket_ms: 300_000,
              points: [
                {
                  t: 1_000,
                  bid_total: 10,
                  ask_total: 5,
                  bid_max: 4,
                  ask_max: 3,
                  imb_max_bid: 4,
                  imb_max_ask: 3,
                },
              ],
            },
          }),
          isLoading: false,
          error: null,
        };
      }
      if (options === rangeSidecarOptions) {
        return {
          data: rangeBundleFixture({
            broker_late_entries: [broker],
            volume_distributions: [distribution],
          }),
          isLoading: true,
          error: null,
        };
      }
      return queryResultFor(options);
    });

    const { result } = renderHook(() => useStudyReferenceBundle(save));

    expect(result.current.isLoading).toBe(false);
    expect(result.current.bundle?.quote_ratio.points).toHaveLength(1);
    expect(result.current.bundle?.broker_late_entries).toEqual([broker]);
    expect(result.current.bundle?.volume_distributions).toEqual([distribution]);
  });
});
