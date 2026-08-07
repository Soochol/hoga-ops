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

// 유효 venue 해석은 심볼 마스터를 `useQuery` 로 읽는데, 이 파일은 그 훅을 통째로
// 모킹해 호출 **횟수와 순서**를 단언한다 — 실제 해석을 태우면 심볼 조회가 그 카운트에
// 끼어든다. 기본은 항등(선택값 그대로)이고, 강등이 흐르는지는 아래 전용 테스트가
// 반환값을 바꿔서 잰다.
vi.mock('../live/useEffectiveVenue', () => ({
  useEffectiveVenue: vi.fn((_code: string | null | undefined, venue: string) => venue),
}));

import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { useLiveVenueStore } from '../state/liveVenue';
import { useEffectiveVenue } from '../live/useEffectiveVenue';
import { useStudyReferenceBundle } from './useStudyReferenceBundle';

// 소스 선호는 이제 설정(`live_settings.krx_prefer_hogaplay`)에서 온다. 설정이 로딩 중이면
// `useOrderflowSourcePref()` 가 undefined 를 주고 쿼리가 비활성화되는데(콜드 마운트 차트
// 스왑 방지), 이 파일이 보는 것은 그 게이트가 아니므로 해소된 기본값으로 고정한다.
// 게이트 자체는 sourcePreference.test.ts 가 검증한다.
vi.mock("../state/sourcePreference", async (orig) => ({
  ...(await orig<typeof import("../state/sourcePreference")>()),
  useOrderflowSourcePref: () => "kiwoom_live",
}));


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
    // 해석 모킹을 **항등으로 복원**한다 — 강등을 재는 테스트가 `mockReturnValue` 로
    // 덮으면 그 값이 다음 테스트까지 남아 "공유 스토어를 따른다" 단언이 거짓 실패한다.
    vi.mocked(useEffectiveVenue).mockImplementation((_code, venue) => venue);
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
    useLiveVenueStore.setState({ venue: 'UN' });
    // 쿼리 키를 정하는 지표는 차트 창 소유다(#904) — 전역이 아니라 창 버킷.
    const chartId = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    useStudyWorkspaceStore.getState().resetChartIndicators(chartId);
    useStudyWorkspaceStore.getState().setChartTimeframe(chartId, save.timeframe);
    useStudyWorkspaceStore.getState().patchChartIndicators(chartId, {
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('passes the shared venue into the study query plan and subscribes 4 disk queries', () => {
    renderHook(() => useStudyReferenceBundle(save));

    // settings 에 venue 가 실린다(ADR-0140 §7) — 캔들 쿼리만 KRX 고정이고
    // 그건 studyReferenceQueries 안에서 처리한다(디스크 캔들 소스는 venue 축이 없다).
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(save, {
      sourcePref: 'kiwoom_live',
      venue: 'UN',
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      depthHeatmapEnabled: false,
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

  it('선택값이 아니라 **해석된** venue 를 싣는다 (NXT 미상장 → KRX 강등)', () => {
    // `studyReferenceQueries` 는 순수 함수라 `rangeBundleQueryOptions` 를 직접 만들고,
    // 그래서 `useRange` 안의 해석(#1214)을 타지 않는다 — 해석이 여기서 빠지면 통합을
    // 고른 복기 뷰가 NXT 미상장 종목에서 **빈 200** 을 받는다.
    useLiveVenueStore.setState({ venue: 'UN' });
    vi.mocked(useEffectiveVenue).mockReturnValue('KRX');

    renderHook(() => useStudyReferenceBundle(save));

    expect(useEffectiveVenue).toHaveBeenCalledWith(save.code, 'UN');
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(
      save,
      expect.objectContaining({ venue: 'KRX' }),
    );
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

  it('follows the shared live venue store (KRX 고정 해제 — ADR-0140 §7)', () => {
    // 숨겼던 이유("복기는 hogaplay 정규장 캡처만 쓴다")가 PR-D 의 venue 세그먼트로
    // 사라졌다. 이제 /live 에서 고른 거래소를 복기도 따른다.
    useLiveVenueStore.setState({ venue: 'NXT' });
    expect(renderHook(() => useStudyReferenceBundle(save)).result.current.venue).toBe('NXT');
    useLiveVenueStore.setState({ venue: 'KRX' });
    expect(renderHook(() => useStudyReferenceBundle(save)).result.current.venue).toBe('KRX');
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
