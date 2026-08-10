import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseQueryOptions, UseQueryResult } from '@tanstack/react-query';
import type { StudyViewReference } from '../api/studyViews';
import type { Candle, RangeBundle } from '../api/types';

const { useQueryMock, useQueriesMock, studyReferenceQueryOptionsMock } = vi.hoisted(() => ({
  // 훅은 `useQueries` 하나로 4×N 을 편다(#801). 개별 결과 팩토리는 그대로 쓰고
  // `useQueriesMock` 이 배열로 접어 준다 — 단언은 계속 "이 옵션이 구독됐는가"다.
  useQueryMock: vi.fn(),
  useQueriesMock: vi.fn(),
  studyReferenceQueryOptionsMock: vi.fn(),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQueries: useQueriesMock,
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
import { useStudyReferenceBundles } from './useStudyReferenceBundle';
import { FACTORY_INDICATOR_SETTINGS, type IndicatorSettings } from '../state/indicatorSettingsV2';
import { useLivePageStore, type LiveTimeframe } from '../state/livePage';

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

const WINDOW_ID = 'win-1';
const indicators: IndicatorSettings = {
  ...FACTORY_INDICATOR_SETTINGS,
  brokerLateEntryEnabled: true,
  brokerLateEntryStartHHMM: 1000,
  tradeVolumePocEnabled: true,
  depthHeatmapEnabled: false,
  volumeDistributionEnabled: true,
  volumeDistributionRangeCount: 12,
};

function spec(timeframe: LiveTimeframe, windowId = WINDOW_ID) {
  return { windowId, timeframe, indicators };
}

/** 단일 창 결과 — 기존 단수 훅 단언을 그대로 옮기기 위한 얇은 어댑터. */
function renderOne(target: StudyViewReference, windowId = WINDOW_ID) {
  const rendered = renderHook(() =>
    useStudyReferenceBundles(target, [spec(target.timeframe as LiveTimeframe, windowId)]));
  return {
    ...rendered,
    get current() { return rendered.result.current[windowId]; },
  };
}

describe('useStudyReferenceBundles', () => {
  beforeEach(() => {
    useQueryMock.mockReset();
    useQueriesMock.mockReset();
    useQueriesMock.mockImplementation(({ queries }: { queries: UseQueryOptions[] }) =>
      queries.map((q) => useQueryMock(q)));
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
    // 쿼리 키를 정하는 지표는 전역 1세트이고, **어느 버킷**인지는 차트 창의 봉이
    // 정한다(#904) — 창 밖 소비자도 같은 조합을 읽어야 "켰는데 안 보임"이 안 난다.
    const chartId = useStudyWorkspaceStore.getState().windows.find((w) => w.kind === 'chart')!.id;
    useStudyWorkspaceStore.getState().setChartTimeframe(chartId, save.timeframe);
    useLivePageStore.setState({ indicatorsByTimeframe: {} });
    useLivePageStore.getState().patchIndicatorsAt(save.timeframe, {
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 1000,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
    });
  });

  it('passes the shared venue into the study query plan and subscribes 4 disk queries', () => {
    renderOne(save);

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
    }, null); // 3번째 인자 null = 분봉이라 캘린더 맥락 창 없음.
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

    renderOne(save);

    expect(useEffectiveVenue).toHaveBeenCalledWith(save.code, 'UN');
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(
      save,
      expect.objectContaining({ venue: 'KRX' }),
      null,
    );
  });

  it('renders minute candles from the disk (mode=candles) query', () => {
    rangeCandlesFixture = [{ ts_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, vol_a: 100, vol_b: 0 }];

    const rendered = renderOne(save);

    expect(rendered.current.bundle?.candles).toHaveLength(1);
  });

  it('renders daily candles from screener gap-fill when hogaplay 1m is absent', () => {
    screenerDailyFixture = [{ t_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, volume: 100 }];

    const rendered = renderOne(dailySave);

    expect(rendered.current.bundle?.candles).toHaveLength(1);
  });

  it('always reports empty pastDataWarnings (disk-only has no KIS delay channel)', () => {
    expect(renderOne(save).current.pastDataWarnings).toEqual([]);
  });

  it('follows the shared live venue store (KRX 고정 해제 — ADR-0140 §7)', () => {
    // 숨겼던 이유("복기는 hogaplay 정규장 캡처만 쓴다")가 PR-D 의 venue 세그먼트로
    // 사라졌다. 이제 /live 에서 고른 거래소를 복기도 따른다.
    useLiveVenueStore.setState({ venue: 'NXT' });
    expect(renderOne(save).current.venue).toBe('NXT');
    useLiveVenueStore.setState({ venue: 'KRX' });
    expect(renderOne(save).current.venue).toBe('KRX');
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

    const rendered = renderOne(save);

    expect(rendered.current.isLoading).toBe(false);
    expect(rendered.current.bundle?.quote_ratio.points).toHaveLength(1);
    expect(rendered.current.bundle?.broker_late_entries).toEqual([broker]);
    expect(rendered.current.bundle?.volume_distributions).toEqual([distribution]);
  });

  it('holds isLoading while the sidecar is pending with no data yet (개선안 1-C)', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: true, error: null };
      }
      return queryResultFor(options);
    });

    expect(renderOne(save).current.isLoading).toBe(true);
  });

  it('does not hold isLoading when the sidecar errors (settle, no permanent hold)', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: false, error: new Error('sidecar failed') };
      }
      return queryResultFor(options);
    });

    expect(renderOne(save).current.isLoading).toBe(false);
  });

  it('holds isLoading while the screener daily gap-fill query is pending', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === screenerDailyOptions) {
        return { data: null, isLoading: true, error: null };
      }
      return queryResultFor(options);
    });

    expect(renderOne(dailySave).current.isLoading).toBe(true);
  });

  // ── 멀티 차트 창 (#801) ──────────────────────────────────────────────
  it('창마다 자기 봉으로 계획을 세운다 — 봉이 곧 쿼리 키다', () => {
    renderHook(() => useStudyReferenceBundles(save, [spec('5m', 'a'), spec('D', 'b')]));

    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeframe: '5m' }), expect.anything(), null);
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ timeframe: 'D' }),
      expect.anything(),
      // 캘린더 봉은 맥락 창을 함께 넘긴다(#1240).
      expect.objectContaining({ from: expect.any(String), to: expect.any(String) }),
    );
  });

  it('같은 설정 창끼리는 쿼리를 한 벌로 접는다 — RQ 의 Duplicate Queries 경고 방지', () => {
    const { result } = renderHook(() =>
      useStudyReferenceBundles(save, [spec('5m', 'a'), spec('5m', 'b')]));

    // 옵션 객체가 같은 4개뿐 — 8개를 넣으면 react-query 가 경고한다(실측).
    expect(useQueryMock).toHaveBeenCalledTimes(4);
    // 그래도 두 창 모두 결과를 받는다.
    expect(Object.keys(result.current).sort()).toEqual(['a', 'b']);
    expect(result.current.a.bundle).toEqual(result.current.b.bundle);
  });

  it('봉이 다르면 창 수만큼 4개씩 구독한다 — 결과는 창 id 로 접힌다', () => {
    // 기본 mock 은 봉과 무관하게 같은 옵션 객체를 주므로(=키 동일) 접기가 걸린다.
    // 여기서는 봉별로 키를 갈라 "다른 봉 = 다른 쿼리" 를 잰다.
    studyReferenceQueryOptionsMock.mockImplementation((s: { timeframe: string }) => ({
      rangeHoga: { queryKey: ['hoga', s.timeframe], enabled: true },
      rangeSidecars: { queryKey: ['sidecar', s.timeframe], enabled: true },
      rangeCandles: { queryKey: ['candles', s.timeframe], enabled: true },
      screenerDaily: { queryKey: ['screener', s.timeframe], enabled: false },
    }));

    const { result } = renderHook(() =>
      useStudyReferenceBundles(save, [spec('5m', 'a'), spec('D', 'b')]));

    expect(useQueryMock).toHaveBeenCalledTimes(8);
    expect(Object.keys(result.current).sort()).toEqual(['a', 'b']);
  });

  it('창이 없으면 아무 쿼리도 걸지 않는다', () => {
    const { result } = renderHook(() => useStudyReferenceBundles(save, []));

    expect(useQueryMock).not.toHaveBeenCalled();
    expect(result.current).toEqual({});
  });
});
