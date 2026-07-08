import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle, RangeBundle } from '../api/types';

const { useQueryMock, studyReferenceQueryOptionsMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
  studyReferenceQueryOptionsMock: vi.fn(),
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
  range: {
    from_date: '20260616',
    to_date: '20260618',
    from_ms: 1_781_568_000_000,
    to_ms: 1_781_568_300_000,
  },
  viewport: { right_edge_ms: 1_781_568_300_000, bar_span: 120, at_live_edge: false },
  memo: '',
  tags: [],
  created_at_ms: 1,
  updated_at_ms: 2,
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
const rangeCandlesOptions = { queryKey: ['range-candles-plan'], enabled: true } as unknown as UseQueryOptions;
const screenerDailyOptions = { queryKey: ['screener-daily-plan'], enabled: false } as unknown as UseQueryOptions;

let rangeCandlesFixture: Candle[] = [];
let rangeCandlesSegments: RangeBundle['segments'] = [];
let screenerDailyFixture: Array<{ t_ms: number; open: number; high: number; low: number; close: number; volume: number }> = [];

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
  if (options === rangeHogaOptions) {
    return { data: null, isLoading: false, error: null };
  }
  if (options === rangeSidecarOptions) {
    return { data: null, isLoading: false, error: null };
  }
  if (options === rangeCandlesOptions) {
    return {
      data: rangeCandlesFixture.length > 0 || rangeCandlesSegments.length > 0
        ? rangeBundleFixture({ candles: rangeCandlesFixture, segments: rangeCandlesSegments })
        : null,
      isLoading: false,
      error: null,
    };
  }
  if (options === screenerDailyOptions) {
    return {
      data: { candles: screenerDailyFixture, data_warnings: [] },
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
      rangeCandles: rangeCandlesOptions,
      screenerDaily: screenerDailyOptions,
    });
    rangeCandlesFixture = [];
    rangeCandlesSegments = [];
    screenerDailyFixture = [];
    useQueryMock.mockImplementation(queryResultFor);
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

  it('uses the shared study reference query plan (no venue in settings) and subscribes 4 disk queries', () => {
    renderHook(() => useStudyReferenceBundle(save));

    // settings에 venue가 없다 — 캔들은 rangeCandles(venue 무관)로만 로드된다.
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(save, {
      sourcePref: 'kis_api_first',
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
    expect(useQueryMock).toHaveBeenNthCalledWith(1, rangeHogaOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(2, rangeSidecarOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(3, rangeCandlesOptions);
    expect(useQueryMock).toHaveBeenNthCalledWith(4, screenerDailyOptions);
    // KIS 훅은 하나도 호출되지 않는다(디스크 온리 계약).
    expect(useQueryMock).toHaveBeenCalledTimes(4);
  });

  it('renders minute candles from the disk (mode=candles) query', () => {
    rangeCandlesFixture = [{ ts_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, vol_a: 100, vol_b: 0 }];

    const { result } = renderHook(() => useStudyReferenceBundle(save));

    expect(result.current.bundle?.candles).toHaveLength(1);
  });

  it('renders daily candles from screener gap-fill when hogaplay 1m is absent', () => {
    screenerDailyFixture = [{ t_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, volume: 100 }];

    const { result } = renderHook(() => useStudyReferenceBundle(dailySave));

    expect(result.current.bundle?.candles).toHaveLength(1);
  });

  it('always reports empty pastDataWarnings (disk-only has no KIS delay channel)', () => {
    const { result } = renderHook(() => useStudyReferenceBundle(save));
    expect(result.current.pastDataWarnings).toEqual([]);
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

  it('holds isLoading while the sidecar is pending with no data yet (개선안 1-C)', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: true, error: null };
      }
      return queryResultFor(options);
    });

    const { result } = renderHook(() => useStudyReferenceBundle(save));

    expect(result.current.isLoading).toBe(true);
  });

  it('does not hold isLoading when the sidecar errors (settle, no permanent hold)', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: false, error: new Error('sidecar failed') };
      }
      return queryResultFor(options);
    });

    const { result } = renderHook(() => useStudyReferenceBundle(save));

    expect(result.current.isLoading).toBe(false);
  });

  it('holds isLoading while the screener daily gap-fill query is pending', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === screenerDailyOptions) {
        return { data: null, isLoading: true, error: null };
      }
      return queryResultFor(options);
    });

    const { result } = renderHook(() => useStudyReferenceBundle(dailySave));

    expect(result.current.isLoading).toBe(true);
  });
});
