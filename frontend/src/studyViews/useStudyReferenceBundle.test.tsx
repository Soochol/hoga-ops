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

// `studyReferenceQueryOptions` **만** 갈아끼운다 — 지표를 쿼리 설정으로 펴는
// `studyReferenceQuerySettings` 는 실물을 쓴다. 이 파일의 단언 중 하나가 "창이 자기 봉의
// 지표를 넘기는가" 이고, 그 매핑까지 흉내 내면 mock 이 정답을 대신 적는 셈이 된다.
vi.mock('./studyReferenceQueries', async (orig) => ({
  ...(await orig<typeof import('./studyReferenceQueries')>()),
  studyReferenceQueryOptions: studyReferenceQueryOptionsMock,
}));

import { useStudyWorkspaceStore } from '../state/studyWorkspace';
import { LIVE_VENUE_OPTIONS, useLiveVenueStore } from '../state/liveVenue';
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
    // 스토어를 **일부러 KRX 가 아닌 값으로** 둔다 — 이 파일의 모든 단언이 "스토어가
    // 뭐든 복기는 KRX" 를 지나가게 하려는 것이다. 'KRX' 로 두면 정책이 사라져도
    // 전부 초록이라 아무것도 증명하지 못한다.
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

  it('pins the study query plan to KRX and subscribes 4 disk queries', () => {
    renderOne(save);

    // 스토어가 'UN' 인데도 settings 에는 KRX 가 실린다(ADR-0144).
    expect(studyReferenceQueryOptionsMock).toHaveBeenCalledWith(save, {
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      // 최대벽 플래그도 창의 지표 설정에서 온다 — 전에는 아예 안 넘겨 백엔드 기본값
      // `True` 로 항상 계산됐다. 여기 공장 기본은 꺼짐이라 false 가 실린다.
      askPeakEnabled: false,
      bidPeakEnabled: false,
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

  // 정책 가드 — **어느 선택값에서도** 복기 쿼리는 KRX 다(ADR-0144). 옵션 목록을
  // 돌리는 이유는 값이 늘어날 때(예: 4번째 거래소) 이 가드가 자동으로 그 값을
  // 덮기 때문이다. 하나만 골라 두면 새 값에 정책이 조용히 안 걸린다.
  it.each(LIVE_VENUE_OPTIONS)('ignores the shared venue store (=%s) and queries KRX', (selected) => {
    useLiveVenueStore.setState({ venue: selected });

    renderOne(save);

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

  it('reports KRX as the bundle venue even while the shared store says otherwise', () => {
    // 쿼리뿐 아니라 **결과에 실려 나가는 venue** 도 KRX 다 — 이 값이 차트의 세션
    // 경계·클립으로 흘러가므로(`studyReferenceBundleModel`), 여기가 스토어를 따르면
    // 데이터는 KRX 인데 x축만 08:00–20:00 으로 벌어진다.
    useLiveVenueStore.setState({ venue: 'NXT' });
    expect(renderOne(save).current.venue).toBe('KRX');
    useLiveVenueStore.setState({ venue: 'UN' });
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

  // 프로그램 순매수는 백엔드가 `program_trade_enabled and sidecar_only` 로 게이트해
  // **sidecar 응답에만** 실린다. 병합에서 빠져 있으면 `...hoga` 의 빈 값이 남아
  // `/study` 에서 그 지표가 영영 안 그려진다 — 토글은 보이는데 화면은 그대로다.
  it('프로그램 순매수는 sidecar 것을 쓴다 — hoga 쪽은 항상 비어 있다', () => {
    const points = [{ t_ms: 1_779_840_000_000, net: 1234 }];
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeHogaOptions) {
        // 백엔드가 hoga 모드에서 채우지 않는다는 사실을 픽스처로 못 박는다.
        return { data: rangeBundleFixture({ program_trade: { points: [] } }), isLoading: false, error: null };
      }
      if (options === rangeSidecarOptions) {
        return {
          data: rangeBundleFixture({ program_trade: { points } as never }),
          isLoading: false,
          error: null,
        };
      }
      return queryResultFor(options);
    });

    expect(renderOne(save).current.bundle?.program_trade?.points).toEqual(points);
  });

  // ── 사이드카는 화면 게이트에서 빠져 있다 (개선안 1-C 뒤집기) ──────────
  //
  // 전에는 "지표가 캔들과 함께 등장하도록" 사이드카를 `isLoading` 에 포함했다
  // (`holds isLoading while the sidecar is pending`). `/study` 에서 그 전제가
  // 깨진다 — 저장 구간 전체를 계산하므로 콜드 73~93초다(2026-08-13 실측: 같은
  // URL 콜드 73.2초 → 웜 2.3초). 지표를 같이 띄우려다 캔들까지 73초 잡아 두는
  // 것이 이 화면 지연의 정체였으므로, 캔들 먼저 띄우고 지표는 나중에 채운다.
  //
  // ⚠ 아래 두 단언은 **방향이 뒤집힌 것**이지 완화된 것이 아니다. 다시 뒤집으려면
  // 위 실측이 달라졌는지부터 확인할 것.
  it('does NOT hold isLoading while the sidecar is pending — 캔들 먼저 (개선안 1-C 뒤집기)', () => {
    // 캔들을 실제로 채운다 — 이 테스트의 요점이 "지표를 기다리는 동안 **캔들은
    // 이미 화면에 있다**" 라서, 빈 픽스처로는 게이트만 재고 요점을 못 잰다.
    rangeCandlesFixture = [{ ts_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, vol_a: 100, vol_b: 0 }];
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: true, error: null };
      }
      return queryResultFor(options);
    });

    const rendered = renderOne(save);
    expect(rendered.current.isLoading).toBe(false);
    // 대신 별도 채널로 보고한다 — 화면을 막지 않으면서 "지표는 아직" 을 말할 수 있어야 한다.
    expect(rendered.current.isSidecarLoading).toBe(true);
    // 그리고 그 사이에도 캔들은 이미 있다.
    expect(rendered.current.chartBundle?.candles?.length).toBeGreaterThan(0);
  });

  it('clears isSidecarLoading once the sidecar settles', () => {
    expect(renderOne(save).current.isSidecarLoading).toBe(false);
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

  it('releases isSidecarLoading when the sidecar errors (settle, 고착 없음)', () => {
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: false, error: new Error('sidecar failed') };
      }
      return queryResultFor(options);
    });

    expect(renderOne(save).current.isSidecarLoading).toBe(false);
  });

  // #1271: 에러 게이트도 로딩 게이트와 **같은 술어로** 갈라야 한다. 한쪽만 갈라면
  // 증상이 "73초 대기" 에서 "백지" 로 옮겨갈 뿐이다 — `studyActiveViewModel` 이
  // `error` 하나로 페이지를 통째로 'error' 로 만들기 때문이다.
  it('keeps a sidecar-only failure out of the page error gate (지표 없는 차트 > 백지)', () => {
    const sidecarFailure = new Error('sidecar failed');
    rangeCandlesFixture = [{ ts_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, vol_a: 100, vol_b: 0 }];
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeSidecarOptions) {
        return { data: null, isLoading: false, error: sidecarFailure };
      }
      return queryResultFor(options);
    });

    const rendered = renderOne(save);
    expect(rendered.current.error).toBeNull();
    // 조용히 삼키지는 않는다 — 별도 채널로 남긴다.
    expect(rendered.current.sidecarError).toBe(sidecarFailure);
    expect(rendered.current.chartBundle?.candles?.length).toBeGreaterThan(0);
  });

  it('still surfaces a hoga failure in the page error gate', () => {
    const hogaFailure = new Error('hoga failed');
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeHogaOptions) {
        return { data: null, isLoading: false, error: hogaFailure };
      }
      return queryResultFor(options);
    });

    expect(renderOne(save).current.error).toBe(hogaFailure);
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

  // ── 캘린더 봉은 스크리너 일봉만 쓴다 ─────────────────────────────────
  //
  // 여기 있던 "스크리너로 먼저 그리고 1분봉이 오면 덧칠한다" 예외 4종은 사라졌다.
  // 그 예외는 캘린더 봉이 1분봉 36,000개를 받던 시절의 완화책이었고, 지금은 그
  // 쿼리를 **아예 안 건다**(`studyReferenceQueryInputs` — 활성/비활성 계약은
  // `studyReferenceQueries.test.ts` 가 고정한다). 예외가 구조로 대체된 것이라
  // 게이트는 다시 단일식이다.

  it('캘린더 봉: 스크리너 일봉만으로 그린다 — 1분봉을 넘겨도 안 섞인다', () => {
    screenerDailyFixture = [{ t_ms: 1_781_568_000_000, open: 1, high: 2, low: 1, close: 2, volume: 100 }];
    rangeCandlesFixture = [
      // 주가 기준이 다른 값(원주가). 섞이면 여기가 화면에 들어온다.
      { ts_ms: 1_781_568_000_000, open: 5, high: 10, low: 5, close: 10, vol_a: 1, vol_b: 0 },
    ];

    const rendered = renderOne(dailySave);

    expect(rendered.current.isLoading).toBe(false);
    expect(rendered.current.bundle?.candles).toHaveLength(1);
    expect(rendered.current.bundle?.candles[0]).toMatchObject({ close: 2 });
  });

  it('분봉은 그대로 rangeCandles 를 기다린다 — 캘린더 봉과 소스가 갈린다', () => {
    // 분봉에서 rangeCandles 는 화면 그 자체다(스크리너 일봉은 아예 비활성).
    useQueryMock.mockImplementation((options: UseQueryOptions) => {
      if (options === rangeCandlesOptions) return { data: null, isLoading: true, error: null };
      return queryResultFor(options);
    });

    expect(renderOne(save).current.isLoading).toBe(true);
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
