import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';

import {
  buildRangeBundleRequest,
  mergedLiveRangeKey,
  mergeRangeBundles,
  planHogaRangeDelta,
  planSidecarRangeDelta,
  useRange,
  useRangeHogaDelta,
  useRangeSidecarDelta,
  rangeBundleQueryOptions,
  rangeFreshnessOptions,
  rangePlaceholderData,
  liveRangeRefreshDue,
  TODAY_RANGE_REFETCH_MS,
} from './range';
import * as client from './client';
import type { RangeBundle } from './types';
import type { RangeBundleRequestInput } from './rangeRequest';
import type { SymbolHit } from './types';
import { useLiveVenueStore } from '../state/liveVenue';
import { seedSymbolMaster, symbolHit } from '../live/seedSymbolMaster';

// 소스 선호는 이제 설정(`live_settings.krx_prefer_hogaplay`)에서 온다. 설정이 로딩 중이면
// `useOrderflowSourcePref()` 가 undefined 를 주고 쿼리가 비활성화되는데(콜드 마운트 차트
// 스왑 방지), 이 파일이 보는 것은 그 게이트가 아니므로 해소된 기본값으로 고정한다.
// 게이트 자체는 sourcePreference.test.ts 가 검증한다.
vi.mock("../state/sourcePreference", async (orig) => ({
  ...(await orig<typeof import("../state/sourcePreference")>()),
  useOrderflowSourcePref: () => "kiwoom_live",
}));


function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
  // 심볼 마스터를 **반드시** 시딩한다 — range 훅이 코드별 유효 venue 를 해석하려고
  // `capture/useSymbols` 를 타는데, 시딩하지 않으면 `/api/symbols/all` 요청이 이
  // 파일의 `apiCall` 모킹 큐를 한 칸 먹어 range 단언이 심볼 URL 을 보게 된다
  // (seedSymbolMaster docstring 이 예고한 함정). 빈 배열 = 전 코드 '모름' 이라
  // 해석은 항등이고, 종전 동작이 그대로 유지된다.
  seedSymbolMaster(qc);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('liveRangeRefreshDue — WS 푸시 승격 무효화 convergence', () => {
  const T = 1_000_000; // an arbitrary fetch time

  it('a promotion after the last fetch triggers a refresh ahead of the 5-min timer', () => {
    expect(liveRangeRefreshDue(T, T + 1_000, T + 500)).toBe(true);
  });

  it('CONVERGES: once the refetch lands (updatedAt past the stamp) it goes false', () => {
    // Promotion at T+500 → refetch → dataUpdatedAt advances to T+600.
    // Same stale stamp must NOT keep re-triggering.
    expect(liveRangeRefreshDue(T + 600, T + 700, T + 500)).toBe(false);
  });

  it('a stamp from before the last fetch never triggers (already covered)', () => {
    expect(liveRangeRefreshDue(T, T + 1_000, T - 500)).toBe(false);
  });

  it('no promotion: within 5 min → false, past 5 min → fallback true', () => {
    expect(liveRangeRefreshDue(T, T + 60_000, 0)).toBe(false);
    expect(liveRangeRefreshDue(T, T + TODAY_RANGE_REFETCH_MS, 0)).toBe(true);
  });

  it('never-fetched query is always due', () => {
    expect(liveRangeRefreshDue(undefined, T, T)).toBe(true);
    expect(liveRangeRefreshDue(0, T, 0)).toBe(true);
  });
});

const fakeBundle: RangeBundle = {
  code: '005930', from_date: '20260512', to_date: '20260512', bucket_ms: 60_000,
  segments: [], candles: [],
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
  volume_distributions: [],
  investorPoints: [],
  ask_peaks: [],
  broker_late_entries: [],
};

describe('buildRangeBundleRequest', () => {
  it('projects one request shape into enabled, URL params, and query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      priceRange: { min: 100, max: 200 },
      todayKst: '20260512',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'hoga',
        brokerLateEntryStartHHMM: 945,
        volumeDistributionBins: 12,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
        tradeVolumePocBins: 12,
      },
    });

    expect(request.enabled).toBe(true);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000'
        + '&price_min=100&price_max=200'
        + '&broker_late_entry_start_hhmm=945'
        + '&volume_distribution_bins=12'
        + '&volume_distribution_price_min=69900&volume_distribution_price_max=70100'
        + '&trade_volume_poc_bins=12'
        + '&source_pref=kiwoom_live&mode=hoga&venue=KRX',
    );
    expect(request.queryKey).toEqual([
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      100,
      200,
      null,
      945,
      12,
      69900,
      70100,
      12,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ]);
  });

  it('adds mode=hoga only for the lightweight hoga request', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'hoga' },
    });

    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512&bucket_ms=60000'
        + '&source_pref=kiwoom_live&mode=hoga&venue=KRX',
    );
    expect(request.queryKey[14]).toBe('hoga');
    // venue 가 키의 맨 끝이라 옵션 게이트는 뒤에서 둘째다(ADR-0140).
    expect(request.queryKey.at(-2)).toBe(null);
  });

  it('adds mode=sidecar for overlay sidecar requests', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'sidecar' },
    });

    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512'
        + '&bucket_ms=60000&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
    expect(request.queryKey[14]).toBe('sidecar');
    // venue 가 키의 맨 끝이라 옵션 게이트는 뒤에서 둘째다(ADR-0140).
    expect(request.queryKey.at(-2)).toBe(null);
  });

  it('threads sidecar indicator gates into the URL params and query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: false,
        tradeVolumePocEnabled: false,
        depthHeatmapEnabled: false,
        depthDeltaEnabled: false,
      },
    });

    expect(request.url).toContain('&ask_peaks_enabled=false');
    expect(request.url).toContain('&bid_peaks_enabled=false');
    expect(request.url).toContain('&program_trade_enabled=false');
    expect(request.url).toContain('&trade_volume_poc_enabled=false');
    expect(request.url).toContain('&depth_heatmap_enabled=false');
    expect(request.url).toContain('&depth_delta_enabled=false');
    // venue 가 키의 맨 끝이라 여섯 게이트는 그 앞 구간이다(ADR-0140).
    expect(request.queryKey.slice(-7, -1)).toEqual([false, false, false, false, false, false]);
  });

  it('adds mode=candles for lightweight candle requests', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260625',
      to: '20260705',
      timeframe: '3m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'candles' },
    });

    expect(request.enabled).toBe(true);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260625&to=20260705'
        + '&bucket_ms=180000&source_pref=kiwoom_live&mode=candles&venue=KRX',
    );
    expect(request.queryKey[14]).toBe('candles');
    // venue 가 키의 맨 끝이라 옵션 게이트는 뒤에서 둘째다(ADR-0140).
    expect(request.queryKey.at(-2)).toBe(null);
  });

  it('includes volumeDistributionCutoffMs in the range query key', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260625',
      to: '20260625',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      },
    });

    expect(request.queryKey).toContain(1_772_000_001_000);
  });

  it('can explicitly disable broker late-entry events', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'hoga', brokerLateEntriesEnabled: false },
    });

    expect(request.url).toContain('&broker_late_entries_enabled=false');
    expect(request.queryKey[7]).toBe(false);
  });

  it('keeps disabled requests representable without optional params', () => {
    const request = buildRangeBundleRequest({
      code: null,
      from: '20260512',
      to: '20260512',
      timeframe: null,
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
    });

    expect(request.enabled).toBe(false);
    expect(request.url).toBe('/api/range?from=20260512&to=20260512&source_pref=kiwoom_live&venue=KRX');
    expect(request.queryKey).toEqual([
      'range',
      null,
      '20260512',
      '20260512',
      null,
      undefined,
      undefined,
      null,
      null,
      null,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ]);
  });

  it('disables complete-looking requests when mode is omitted', () => {
    const request = buildRangeBundleRequest({
      code: '005930',
      from: '20260512',
      to: '20260512',
      timeframe: '1m',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
    });

    expect(request.enabled).toBe(false);
    expect(request.url).toBe(
      '/api/range?code=005930&from=20260512&to=20260512'
        + '&bucket_ms=60000&source_pref=kiwoom_live&venue=KRX',
    );
    expect(request.queryKey[14]).toBe(null);
    // venue 가 키의 맨 끝이라 옵션 게이트는 뒤에서 둘째다(ADR-0140).
    expect(request.queryKey.at(-2)).toBe(null);
  });
});

describe('planSidecarRangeDelta', () => {
  const previous: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260629',
    to_date: '20260706',
    bucket_ms: 60_000,
  };
  const previousRequest: RangeBundleRequestInput = {
    code: '005930',
    from: '20260629',
    to: '20260706',
    timeframe: '1m',
    todayKst: '20260706',
    sourcePref: 'kiwoom_live' as const,
    venue: 'KRX' as const,
    options: {
      mode: 'sidecar' as const,
      askPeaksEnabled: false,
      bidPeaksEnabled: false,
      programTradeEnabled: true,
      tradeVolumePocEnabled: true,
      volumeDistributionBins: 10,
      tradeVolumePocBins: 10,
      volumeDistributionPriceRange: { min: 303000, max: 325000 },
    },
  };
  const previousIdentity = planSidecarRangeDelta(previousRequest).identity;

  it('plans only the missing left delta for compatible live sidecar ranges when given the actual previous identity', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: true,
        tradeVolumePocEnabled: true,
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 303000, max: 325000 },
      },
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });

  it('caps a wide left-extension gap at LIVE_RANGE_CHUNK_DAYS (chunk walkback tile)', () => {
    // 갭 [20260501, 20260628]은 통짜가 아니라 previous 좌측 인접 7일 타일만.
    // 타일이 merge되면 previous.from_date가 전진해 다음 타일을 자기구동으로 당긴다.
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260501',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260622');
    expect(plan.requestInput.to).toBe('20260628');
    expect(plan.blocksHistoricalExtension).toBe(true);
  });

  it('seeds only the most-recent chunk on a cold plan (no previous bundle)', () => {
    // 콜드 딥 뷰포트(저장 뷰포트 복원)가 종전엔 [from, 오늘] 통짜 1방이었다
    // (2026-07-11 슬로그: 2개월 콜드 peak ~52s). 시드 창만 먼저 받는다.
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260518',
    });

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260630');
    expect(plan.requestInput.to).toBe('20260706');
    expect(plan.blocksHistoricalExtension).toBe(true);
  });

  it('keeps a cold plan within LIVE_RANGE_CHUNK_DAYS as a single full request', () => {
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260701',
    });

    expect(plan.enabled).toBe(true);
    expect(plan.requestInput.from).toBe('20260701');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('refreshes only the today sidecar slice when previous data already covers the requested range', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260629',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous, planSidecarRangeDelta({
      ...previousRequest,
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }).identity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260706');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('serves the deep previous bundle and refreshes only today when previous is DEEPER than the requested seed (warm return)', () => {
    // 웜 복귀(종목 전환 후 복귀·타임프레임 전환): setActiveCode/setCandleTimeframe 이
    // historicalFromDate 를 null 로 리셋해 input.from 이 시드 창(20260701)으로
    // 좁아지지만, 캐시엔 이전 세션 좌측 팬으로 확장해 둔 딥 번들(from_date 20260629)이
    // 남아 있다. 종전엔 previous.from_date < input.from 을 좁은 창 통짜 재요청 +
    // servePrevious:false 로 폐기해 지표만 얕아졌다. 이제 딥 서빙 + 오늘-델타로 수렴.
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260701',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    // 좁은 창 [20260701, 20260706] 통짜 재요청이 아니라 오늘-델타만.
    expect(plan.requestInput.from).toBe('20260706');
    expect(plan.requestInput.to).toBe('20260706');
    expect(plan.blocksHistoricalExtension).toBe(false);
  });

  it('seeds only the most-recent chunk when to-date changes (identity break)', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260707',
      timeframe: '1m',
      todayKst: '20260707',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }, previous, planSidecarRangeDelta({
      ...previousRequest,
      todayKst: '20260707',
      options: { mode: 'sidecar', volumeDistributionBins: 10 },
    }).identity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    // LIVE_RANGE_CHUNK_DAYS 시드: 통짜 [0624,0707] 대신 최근 7일 창만. 나머지는
    // 시드 랜딩 후 확장-타일 분기가 청크 워크백한다.
    expect(plan.requestInput.from).toBe('20260701');
    expect(plan.requestInput.to).toBe('20260707');
    expect(plan.blocksHistoricalExtension).toBe(true);
  });

  it('does not delta-plan cutoff sidecar profile requests', () => {
    const plan = planSidecarRangeDelta({
      code: '005930',
      from: '20260624',
      to: '20260624',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      },
    }, previous, previousIdentity);

    expect(plan.canReusePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260624');
  });

  it('seeds only the most-recent chunk when venue changed', () => {
    // 소스 선호 옵션 폐지(2026-08-07) 후 identity 를 바꾸는 사용자 축은 venue 다.
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260624',
      venue: 'NXT',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260630');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('keeps identity across a vdist price-range change (today-slice refresh, no cold seed)', () => {
    // 오늘 세션 신고/신저가로 vdist 경계가 흔들려도 identity는 불변 — 과거일
    // vdist는 per-day 로컬 캔들 범위 우선(백엔드 폴백 의미론)이라 재사용 정합.
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      options: {
        ...previousRequest.options,
        volumeDistributionPriceRange: { min: 304000, max: 326000 },
      },
    }, previous, previousIdentity);

    expect(plan.identity).toBe(previousIdentity);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    // at-rest: 오늘 슬라이스 refresh 게이트로 수렴 (콜드 시드 재실행 없음).
    expect(plan.requestInput.from).toBe('20260706');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('keeps a narrow extension tile across a vdist price-range change', () => {
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260624',
      options: {
        ...previousRequest.options,
        volumeDistributionPriceRange: { min: 304000, max: 326000 },
      },
    }, previous, previousIdentity);

    expect(plan.canReusePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });

  it('seeds only the most-recent chunk when sidecar options changed', () => {
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260624',
      options: {
        ...previousRequest.options,
        tradeVolumePocEnabled: false,
      },
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260630');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('seeds only the most-recent chunk when timeframe identity changed', () => {
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260624',
      timeframe: '3m',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260630');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('falls back to a full request for past-only sidecar ranges', () => {
    const plan = planSidecarRangeDelta({
      ...previousRequest,
      from: '20260624',
      to: '20260628',
      todayKst: '20260706',
    }, {
      ...previous,
      from_date: '20260625',
      to_date: '20260628',
    }, planSidecarRangeDelta({
      ...previousRequest,
      from: '20260625',
      to: '20260628',
      todayKst: '20260706',
    }).identity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });
});

describe('planHogaRangeDelta', () => {
  const previous: RangeBundle = {
    ...fakeBundle,
    code: '005930',
    from_date: '20260629',
    to_date: '20260706',
    bucket_ms: 60_000,
  };
  const previousRequest: RangeBundleRequestInput = {
    code: '005930',
    from: '20260629',
    to: '20260706',
    timeframe: '1m',
    todayKst: '20260706',
    sourcePref: 'kiwoom_live' as const,
    venue: 'KRX' as const,
    options: { mode: 'hoga' as const },
  };
  const previousIdentity = planHogaRangeDelta(previousRequest).identity;

  it('plans only the missing left delta for compatible live hoga ranges', () => {
    const plan = planHogaRangeDelta({
      ...previousRequest,
      from: '20260624',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });

  it('refreshes only today hoga slice when previous data already covers the requested range', () => {
    const plan = planHogaRangeDelta({
      ...previousRequest,
      from: '20260629',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260706');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('serves the deep previous bundle and refreshes only today when previous is DEEPER (warm return)', () => {
    // sidecar 와 동일 계약(웜 복귀): 딥 previous 서빙 + 오늘-델타, 좁은 창 통짜 폐기 금지.
    const plan = planHogaRangeDelta({
      ...previousRequest,
      from: '20260701',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(true);
    expect(plan.servePrevious).toBe(true);
    expect(plan.requestInput.from).toBe('20260706');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('seeds only the most-recent chunk when hoga identity changes', () => {
    // identity 축은 venue 다 — 소스 선호 옵션 폐지(2026-08-07).
    const plan = planHogaRangeDelta({
      ...previousRequest,
      from: '20260624',
      venue: 'NXT',
    }, previous, previousIdentity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260630');
    expect(plan.requestInput.to).toBe('20260706');
  });

  it('falls back to full request for past-only hoga ranges', () => {
    const plan = planHogaRangeDelta({
      ...previousRequest,
      from: '20260624',
      to: '20260628',
      todayKst: '20260706',
    }, {
      ...previous,
      from_date: '20260625',
      to_date: '20260628',
    }, planHogaRangeDelta({
      ...previousRequest,
      from: '20260625',
      to: '20260628',
      todayKst: '20260706',
    }).identity);

    expect(plan.enabled).toBe(true);
    expect(plan.canReusePrevious).toBe(false);
    expect(plan.servePrevious).toBe(false);
    expect(plan.requestInput.from).toBe('20260624');
    expect(plan.requestInput.to).toBe('20260628');
  });
});

describe('mergeRangeBundles', () => {
  it('merges sidecar arrays by stable date/key and keeps chronological order', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      segments: [{ date: '20260629', session_open_ms: 1, session_close_ms: 2, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260629', price: 10, qty: 1, t_ms: 1, max_price: 10, max_qty: 1, max_t_ms: 1 }],
      bid_peaks: [{ date: '20260629', price: 9, qty: 1, t_ms: 1, max_price: 9, max_qty: 1, max_t_ms: 1 }],
      broker_late_entries: [{ t_ms: 2, broker: 'NH투자증권', side: 'buy', net: 100 }],
      trade_volume_pocs: [{ date: '20260629', center_price: 10, low_price: 9, high_price: 11, qty: 1, t_ms: 1, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260629',
        range_count: 10,
        price_min: 9,
        price_max: 11,
        session_open_ms: 1,
        session_close_ms: 2,
        bins: [{ price_low: 9, price_high: 10, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 2, net_qty: 10, net_amount: 100, delta_qty: 10, delta_amount: 100, gap_risk: false }],
      },
      excluded_dates: [{
        date: '20260630',
        violations: [{ invariant_id: 'qr_shape', severity: 'error', message: 'bad shape', ctx: { code: '005930' } }],
      }],
      data_warnings: [{
        date: '20260629',
        warnings: [{ invariant_id: 'qr_gap', severity: 'warn', message: 'gap', ctx: { code: '005930' } }],
      }],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      segments: [{ date: '20260624', session_open_ms: 3, session_close_ms: 4, source: 'hogaplay' }],
      ask_peaks: [{ date: '20260624', price: 8, qty: 1, t_ms: 3, max_price: 8, max_qty: 1, max_t_ms: 3 }],
      bid_peaks: [{ date: '20260624', price: 7, qty: 1, t_ms: 3, max_price: 7, max_qty: 1, max_t_ms: 3 }],
      broker_late_entries: [{ t_ms: 1, broker: 'NH투자증권', side: 'sell', net: -50 }],
      trade_volume_pocs: [{ date: '20260624', center_price: 8, low_price: 7, high_price: 9, qty: 1, t_ms: 3, band_pct: 0.005 }],
      volume_distributions: [{
        date: '20260624',
        range_count: 10,
        price_min: 7,
        price_max: 9,
        session_open_ms: 3,
        session_close_ms: 4,
        bins: [{ price_low: 7, price_high: 8, qty: 1 }],
      }],
      program_trade: {
        source: 'kis_program_trade',
        points: [{ t: 1, net_qty: 5, net_amount: 50, delta_qty: 5, delta_amount: 50, gap_risk: false }],
      },
      excluded_dates: [{
        date: '20260625',
        violations: [{ invariant_id: 'qr_shape', severity: 'error', message: 'bad shape', ctx: { code: '005930' } }],
      }],
      data_warnings: [{
        date: '20260624',
        warnings: [{ invariant_id: 'qr_gap', severity: 'warn', message: 'gap', ctx: { code: '005930' } }],
      }],
    };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.from_date).toBe('20260624');
    expect(merged.to_date).toBe('20260706');
    expect(merged.segments.map((s) => s.date)).toEqual(['20260624', '20260629']);
    expect(merged.ask_peaks.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.bid_peaks?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.trade_volume_pocs?.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.volume_distributions.map((p) => p.date)).toEqual(['20260624', '20260629']);
    expect(merged.broker_late_entries.map((e) => e.t_ms)).toEqual([1, 2]);
    expect(merged.program_trade?.points.map((p) => p.t)).toEqual([1, 2]);
    expect(merged.excluded_dates?.map((e) => e.date)).toEqual(['20260625', '20260630']);
    expect(merged.data_warnings?.map((w) => w.date)).toEqual(['20260624', '20260629']);
  });

  it('dedupes overlapping rows by stable key and keeps the newer bundle values', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260706',
      segments: [{ date: '20260706', session_open_ms: 1, session_close_ms: 4, source: 'hogaplay' }],
      candles: [
        { ts_ms: 1, open: 10, high: 10, low: 10, close: 10, vol_a: 1, vol_b: 0 },
        { ts_ms: 2, open: 11, high: 11, low: 11, close: 11, vol_a: 1, vol_b: 0 },
      ],
      quote_ratio: {
        bucket_ms: 60_000,
        points: [
          { t: 1, bid_total: 10, ask_total: 9, bid_max: 5, ask_max: 4, imb_max_bid: 1, imb_max_ask: 0, band_pct: 0, tick: 0 },
          { t: 2, bid_total: 11, ask_total: 9, bid_max: 5, ask_max: 4, imb_max_bid: 1, imb_max_ask: 0, band_pct: 0, tick: 0 },
        ],
      },
      fill_strength: {
        bucket_ms: 60_000,
        points: [
          { t: 1, buy_qty: 10, sell_qty: 1 },
          { t: 2, buy_qty: 11, sell_qty: 1 },
        ],
      },
      ask_peaks: [{ date: '20260706', price: 10, qty: 1, t_ms: 1, max_price: 10, max_qty: 1, max_t_ms: 1 }],
      bid_peaks: [{ date: '20260706', price: 9, qty: 1, t_ms: 1, max_price: 9, max_qty: 1, max_t_ms: 1 }],
      broker_late_entries: [
        { t_ms: 1, broker: 'NH투자증권', side: 'buy', net: 100 },
        { t_ms: 2, broker: '삼성증권', side: 'buy', net: 50 },
      ],
      trade_volume_pocs: [{ date: '20260706', center_price: 10, low_price: 9, high_price: 11, qty: 1, t_ms: 1, band_pct: 0.005 }],
      volume_distributions: [{ date: '20260706', range_count: 10, price_min: 9, price_max: 11, session_open_ms: 1, session_close_ms: 2, bins: [{ price_low: 9, price_high: 10, qty: 1 }] }],
      program_trade: {
        source: 'kis_program_trade',
        points: [
          { t: 1, net_qty: 10, net_amount: 100, delta_qty: 10, delta_amount: 100, gap_risk: false },
          { t: 2, net_qty: 11, net_amount: 110, delta_qty: 1, delta_amount: 10, gap_risk: false },
        ],
      },
    };
    const next: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260706',
      to_date: '20260706',
      segments: [{ date: '20260706', session_open_ms: 1, session_close_ms: 4, source: 'kiwoom_live' }],
      candles: [{ ts_ms: 1, open: 20, high: 20, low: 20, close: 20, vol_a: 2, vol_b: 0 }],
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1, bid_total: 20, ask_total: 19, bid_max: 6, ask_max: 5, imb_max_bid: 1, imb_max_ask: 0, band_pct: 0, tick: 0 }] },
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1, buy_qty: 20, sell_qty: 2 }] },
      ask_peaks: [{ date: '20260706', price: 20, qty: 2, t_ms: 2, max_price: 20, max_qty: 2, max_t_ms: 2 }],
      bid_peaks: [{ date: '20260706', price: 19, qty: 2, t_ms: 2, max_price: 19, max_qty: 2, max_t_ms: 2 }],
      broker_late_entries: [{ t_ms: 1, broker: 'NH투자증권', side: 'buy', net: 200 }],
      trade_volume_pocs: [{ date: '20260706', center_price: 20, low_price: 19, high_price: 21, qty: 2, t_ms: 2, band_pct: 0.005 }],
      volume_distributions: [{ date: '20260706', range_count: 10, price_min: 19, price_max: 21, session_open_ms: 3, session_close_ms: 4, bins: [{ price_low: 19, price_high: 20, qty: 2 }] }],
      program_trade: { source: 'kis_program_trade', points: [{ t: 1, net_qty: 20, net_amount: 200, delta_qty: 20, delta_amount: 200, gap_risk: false }] },
    };

    const merged = mergeRangeBundles(previous, next);

    expect(merged.segments).toEqual(next.segments);
    expect(merged.candles).toEqual(next.candles);
    expect(merged.quote_ratio.points).toEqual(next.quote_ratio.points);
    expect(merged.fill_strength.points).toEqual(next.fill_strength.points);
    expect(merged.ask_peaks).toEqual(next.ask_peaks);
    expect(merged.bid_peaks).toEqual(next.bid_peaks);
    expect(merged.broker_late_entries).toEqual(next.broker_late_entries);
    expect(merged.trade_volume_pocs).toEqual(next.trade_volume_pocs);
    expect(merged.volume_distributions).toEqual(next.volume_distributions);
    expect(merged.program_trade?.points).toEqual(next.program_trade?.points);
  });

  // #1133 — 도그푸딩 실측으로 잡은 결함. `...next` 스프레드만으로는 결손 사유가
  // **팬 한 번에 사라진다**: 8/1~8/7 요청이 `missing_dates=[8/5]` 를 주고, 이어지는
  // 7/31 단일 청크가 `[]` 를 주면서 앞의 것을 덮었다. 화면에서는 안내가 떴다가
  // 조용히 없어지므로 "가끔 안 뜬다" 로만 보인다 — 단위 테스트 없이는 못 잡는다.
  it('결손 사유는 next 가 덮지 않은 날짜를 보존한다', () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      from_date: '20260801',
      to_date: '20260807',
      segments: [{ date: '20260806', session_open_ms: 1, session_close_ms: 2, source: 'kiwoom_live' }],
      missing_dates: [{ date: '20260805', reason: 'source_missing' }],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      from_date: '20260731',
      to_date: '20260731',
      segments: [],
      missing_dates: [],
    };

    expect(mergeRangeBundles(previous, next).missing_dates)
      .toEqual([{ date: '20260805', reason: 'source_missing' }]);
  });

  it('next 가 덮은 날짜의 결손 사유는 next 것으로 갈린다', () => {
    // 그 날짜를 다시 읽었으면 최신 판정이 옳다 — 재캡처로 결손이 해소된 경우가 그렇다.
    const previous: RangeBundle = {
      ...fakeBundle,
      segments: [],
      missing_dates: [{ date: '20260806', reason: 'source_missing' }],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      segments: [{ date: '20260806', session_open_ms: 1, session_close_ms: 2, source: 'kiwoom_live' }],
      missing_dates: [],
    };

    expect(mergeRangeBundles(previous, next).missing_dates).toEqual([]);
  });
});

describe('rangeBundleQueryOptions', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('builds reusable range query options with an abortable query function', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const options = rangeBundleQueryOptions({
      code: '005930',
      from: '20260616',
      to: '20260618',
      timeframe: '5m',
      todayKst: null,
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options: {
        mode: 'hoga',
        volumeDistributionBins: 12,
        tradeVolumePocBins: 12,
        volumeDistributionPriceRange: null,
      },
    });

    expect(options.enabled).toBe(true);
    expect(options.queryKey).toEqual([
      'range',
      '005930',
      '20260616',
      '20260618',
      300_000,
      undefined,
      undefined,
      null,
      null,
      12,
      undefined,
      undefined,
      12,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ]);

    const signal = new AbortController().signal;
    const queryFn = options.queryFn as (context: { signal: AbortSignal }) => Promise<RangeBundle>;
    await queryFn({ signal });
    expect(spy).toHaveBeenCalledWith(
      '/api/range?code=005930&from=20260616&to=20260618&bucket_ms=300000&volume_distribution_bins=12&trade_volume_poc_bins=12&source_pref=kiwoom_live&mode=hoga&venue=KRX',
      { signal },
    );
  });
});

describe('useRange', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('disabled when any input is null', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange(null, '20260512', '20260512', '1m'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('calls /api/range with correct query string (bucket_ms from Timeframe)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', '5m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy).toHaveBeenCalledWith(
      // **접두 매처**다 — venue 는 쿼리스트링 끝이라 여기 붙이면 안 맞는다.
      expect.stringContaining('/api/range?code=005930&from=20260512&to=20260512&bucket_ms=300000'),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('appends price_min/price_max when priceRange given', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', { min: 100, max: 200 }, undefined, { mode: 'hoga' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&price_min=100&price_max=200');
  });

  it('disabled if timeframe is null even with other inputs', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', null),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('disabled if mode is omitted even with complete inputs', () => {
    const spy = vi.spyOn(client, 'apiCall');
    const { result } = renderHook(
      () => useRange('005930', '20260512', '20260512', '1m'),
      { wrapper: makeWrapper() },
    );
    expect(result.current.isLoading).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('threads sourcePref into the query string and key', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({} as RangeBundle);

    renderHook(
      () => useRange('005930', '20260520', '20260520', '1m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=kiwoom_live');
  });

  it('allows a caller to override the global source preference for one range query', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({} as RangeBundle);

    renderHook(
      () => useRange(
        '005930',
        '20260520',
        '20260520',
        '1m',
        undefined,
        undefined,
        { mode: 'hoga' },
        'kiwoom_live',
      ),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(client.apiCall).toHaveBeenCalled());
    const calledWith = (client.apiCall as ReturnType<typeof vi.spyOn>).mock.calls[0][0] as string;
    expect(calledWith).toContain('source_pref=kiwoom_live');
  });

  it('omits volume_distribution_bins when not requested', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).not.toContain('volume_distribution_bins=');
    expect(spy.mock.calls[0][0]).not.toContain('trade_volume_poc_bins=');
  });

  it('threads volume_distribution_bins into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { mode: 'hoga', volumeDistributionBins: 20 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_bins=20');
  });

  it('threads volume_distribution_cutoff_ms into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260625', '20260625', '1m', undefined, null, {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionCutoffMs: 1_772_000_001_000,
      }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_cutoff_ms=1772000001000');
  });

  it('threads volume_distribution_price_min/max into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, {
        volumeDistributionBins: 10,
        mode: 'hoga',
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&volume_distribution_price_min=69900&volume_distribution_price_max=70100');
  });

  it('threads trade_volume_poc_bins into query string', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRange('005930', '20260512', '20260512', '1m', undefined, null, { mode: 'hoga', tradeVolumePocBins: 12 }),
      { wrapper: makeWrapper() },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls[0][0]).toContain('&trade_volume_poc_bins=12');
  });

  it('threads broker_late_entry_start_hhmm into query string and query key', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { rerender } = renderHook(
      ({ brokerLateEntryStartHHMM }) => useRange(
        '005930',
        '20260512',
        '20260512',
        '1m',
        undefined,
        null,
        { mode: 'hoga', brokerLateEntryStartHHMM },
      ),
      {
        wrapper: makeWrapper(),
        initialProps: { brokerLateEntryStartHHMM: 945 },
      },
    );

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy.mock.calls[0][0]).toContain('&broker_late_entry_start_hhmm=945');

    rerender({ brokerLateEntryStartHHMM: 950 });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toContain('&broker_late_entry_start_hhmm=950');
  });

});

describe('useRangeSidecarDelta', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('fetches only missing left sidecar dates and does not full-refetch after merge', async () => {
    const first: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260629', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const delta: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260624', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(String(url).includes('from=20260624&to=20260628') ? delta : first),
    );
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeSidecarDelta('005930', from, '20260706', '1m', undefined, '20260706', {
          mode: 'sidecar',
          volumeDistributionBins: 10,
          volumeDistributionPriceRange: { min: 303000, max: 325000 },
        }, 'kiwoom_live'),
      { wrapper, initialProps: { from: '20260629' } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624' });

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('from=20260624&to=20260628'))).toBe(true));
    expect(spy.mock.calls.map(([url]) => String(url))).toContain(
      '/api/range?code=005930&from=20260624&to=20260628&bucket_ms=60000'
        + '&volume_distribution_bins=10'
        + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
        + '&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    expect(result.current.data?.to_date).toBe('20260706');
    expect(result.current.data?.volume_distributions.map((d) => d.date)).toEqual(['20260624', '20260629']);
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/range?code=005930&from=20260624&to=20260706&bucket_ms=60000'
        + '&volume_distribution_bins=10'
        + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
        + '&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
  });

  it('cold-loads a deep viewport via seed + chunk walkback (every request ≤ 7 calendar days)', async () => {
    // 콜드 딥 뷰포트: 통짜 [20260601, 20260706] 금지 — 시드 [0630,0706] 후
    // 7일 타일 워크백으로 from까지 자기구동 수렴해야 한다.
    const today = '20260706';
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return {
        ...fakeBundle,
        code: '005930',
        from_date: m ? m[1] : today,
        to_date: m ? m[2] : today,
        bucket_ms: 60_000,
      };
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useRangeSidecarDelta('005930', '20260601', today, '1m', undefined, today, {
          mode: 'sidecar',
          volumeDistributionBins: 10,
        }, 'kiwoom_live'),
      { wrapper },
    );

    // 워크백 완주: merged from_date가 요청 from까지 도달.
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260601'), { timeout: 5000 });

    const spans = spy.mock.calls.map(([url]) => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return m ? ([m[1], m[2]] as const) : null;
    }).filter((s): s is readonly [string, string] => s != null);
    // 통짜 요청 부재 + 모든 요청이 7 달력일 이내.
    expect(spans.some(([f, t]) => f === '20260601' && t === today)).toBe(false);
    const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) / 86_400_000;
    for (const [f, t] of spans) {
      expect(dayNum(t) - dayNum(f)).toBeLessThan(7);
    }
    // 시드가 최근 창이고, 이후 타일들이 좌측으로 인접 연속.
    expect(spans[0]).toEqual(['20260630', today]);
    expect(spans.slice(1).map(([f, t]) => `${f}-${t}`)).toEqual([
      '20260623-20260629',
      '20260616-20260622',
      '20260609-20260615',
      '20260602-20260608',
      '20260601-20260601',
    ]);
  });

  it('keeps the deep merged bundle on a warm return that narrows from to the seed window (no cumulative refetch)', async () => {
    // 웜 복귀 회귀 가드: 딥 뷰포트를 먼저 축적한 뒤 from 이 시드 창으로 좁아지면
    // (종목 전환 후 복귀·타임프레임 전환의 historicalFromDate=null 리셋 시뮬),
    // 캔들과 달리 지표만 딥을 폐기하고 좁은 창을 통짜 재요청하던 것이 이번 수정의
    // 대상이다. data 는 딥(from_date 20260629)을 유지하고, 좁은 창 통짜
    // [20260703, 20260706] 요청은 절대 나가지 않아야 한다.
    const today = '20260706';
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return {
        ...fakeBundle,
        code: '005930',
        from_date: m ? m[1] : today,
        to_date: m ? m[2] : today,
        bucket_ms: 60_000,
      };
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));
    const options = { mode: 'sidecar' as const, volumeDistributionBins: 10 };
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeSidecarDelta('005930', from, today, '1m', undefined, today, options, 'kiwoom_live'),
      { wrapper: makeWrapper(), initialProps: { from: '20260629' } },
    );

    // 딥 축적: 시드 [0630,0706] + 좌측 타일 [0629,0629] 워크백 → from_date 20260629.
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));

    // 웜 복귀: from 이 시드 창 이내로 좁아짐. 딥 유지 + 좁은 통짜 요청 부재.
    rerender({ from: '20260703' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    expect(result.current.data?.to_date).toBe(today);

    const urls = spy.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => /from=20260703&to=20260706/.test(u))).toBe(false);
  });

  it('publishes a canonical merged bundle that survives range eviction and restores on remount (PR-2)', async () => {
    // PR-2: 병합본을 ['live','range-merged',identity] 에 발행 → /study 축출
    // (removeQueries(['range']))·리마운트·gcTime 초과에도 딥을 잃지 않는다.
    const today = '20260706';
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return {
        ...fakeBundle,
        code: '005930',
        from_date: m ? m[1] : today,
        to_date: m ? m[2] : today,
        bucket_ms: 60_000,
      };
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const options = { mode: 'sidecar' as const, volumeDistributionBins: 10 };
    const identity = planSidecarRangeDelta({
      code: '005930', from: '20260629', to: today, timeframe: '1m', todayKst: today,
      sourcePref: 'kiwoom_live', venue: 'KRX', options,
    }).identity;

    const view = renderHook(
      () => useRangeSidecarDelta('005930', '20260629', today, '1m', undefined, today, options, 'kiwoom_live'),
      { wrapper },
    );
    // 시드 [0630,0706] + 타일 [0629,0629] 워크백 → 딥 from_date 20260629.
    await waitFor(() => expect(view.result.current.data?.from_date).toBe('20260629'));
    // canonical 병합본이 발행됐다.
    expect(qc.getQueryData(mergedLiveRangeKey(identity))).toMatchObject({ from_date: '20260629', to_date: today });

    // /study 축출 시뮬 — 실 청크 키(['range', …])만 지운다. canonical 은 prefix 불일치로 생존.
    qc.removeQueries({ queryKey: ['range'] });
    expect(qc.getQueryData(mergedLiveRangeKey(identity))).toMatchObject({ from_date: '20260629' });

    view.unmount();
    const callsBefore = spy.mock.calls.length;

    // 리마운트: mergedRef 소실 → canonical O(1) 복원으로 즉시 딥, 통짜 재요청 없음.
    const view2 = renderHook(
      () => useRangeSidecarDelta('005930', '20260629', today, '1m', undefined, today, options, 'kiwoom_live'),
      { wrapper },
    );
    await waitFor(() => expect(view2.result.current.data?.from_date).toBe('20260629'));
    expect(view2.result.current.data?.to_date).toBe(today);
    const newUrls = spy.mock.calls.slice(callsBefore).map(([u]) => String(u));
    // 통짜 재요청 없음 + 콜드 시드([0630,0706]) 재발사 없음 = canonical 복원 증명
    // (복원 실패 시 축출된 청크를 시드부터 다시 워크백했을 것).
    expect(newUrls.some((u) => /from=20260629&to=20260706/.test(u))).toBe(false);
    expect(newUrls.some((u) => /from=20260630&to=20260706/.test(u))).toBe(false);
  });

  it('does not reuse a canonical merged bundle from a different identity after a date rollover (PR-2)', async () => {
    // 날짜 롤오버(to 20260705→20260706)는 identity 를 깨므로 어제 병합본을 초기
    // previous 로 집지 않는다 — 콜드 시드부터 시작해야 stale 어제 데이터가 새어들지 않는다.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    const options = { mode: 'sidecar' as const, volumeDistributionBins: 10 };
    const yesterdayIdentity = planSidecarRangeDelta({
      code: '005930', from: '20260620', to: '20260705', timeframe: '1m', todayKst: '20260705',
      sourcePref: 'kiwoom_live', venue: 'KRX', options,
    }).identity;
    qc.setQueryData(mergedLiveRangeKey(yesterdayIdentity), {
      ...fakeBundle, code: '005930', from_date: '20260620', to_date: '20260705', bucket_ms: 60_000,
    });
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return Promise.resolve({ ...fakeBundle, code: '005930', from_date: m ? m[1] : '', to_date: m ? m[2] : '', bucket_ms: 60_000 });
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    renderHook(
      () => useRangeSidecarDelta('005930', '20260620', '20260706', '1m', undefined, '20260706', options, 'kiwoom_live'),
      { wrapper },
    );

    // 첫 요청이 오늘 identity 의 콜드 시드([0630,0706])여야 한다. 어제 병합본을
    // 집었다면 input.from(20260620) <= previous.from_date(20260620) → 오늘-델타
    // [0706,0706]가 첫 요청이 됐을 것.
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(String(spy.mock.calls[0][0])).toMatch(/from=20260630&to=20260706/);
  });

  it('reports isHistoricalDeltaFetching during a COLD in-flight fetch (backpressure blind spot)', async () => {
    // 콜드에는 placeholder가 없어 종전 신호(isPlaceholderData 의존)가 false였다
    // → 콜드 52s 창 동안 팬이 추가 통짜를 발사(슬로그: 동일 wide 3건 동시).
    let resolve!: (b: RangeBundle) => void;
    const gate = new Promise<RangeBundle>((r) => { resolve = r; });
    vi.spyOn(client, 'apiCall').mockImplementation(() => gate);
    const wrapper = makeWrapper();
    const { result } = renderHook(
      () =>
        useRangeSidecarDelta('005930', '20260601', '20260706', '1m', undefined, '20260706', {
          mode: 'sidecar',
          volumeDistributionBins: 10,
        }, 'kiwoom_live'),
      { wrapper },
    );

    // 콜드 fetch in-flight: 배압 신호가 켜져 있어야 확장 트리거가 홀드된다.
    await waitFor(() => expect(result.current.isFetching).toBe(true));
    expect(result.current.isHistoricalDeltaFetching).toBe(true);

    resolve({ ...fakeBundle, code: '005930', from_date: '20260630', to_date: '20260706', bucket_ms: 60_000 });
    // 시드 랜딩 렌더에서 하강(점진 페인트 + settle-loop pull 엣지 보존).
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260630'));
  });

  // Reproduction probe for the "cumulative sidecar storm" seen in server logs
  // (from moving back, to fixed at today, repeated). With a STABLE price range,
  // consecutive left-scrolls must each stay a NARROW tile — never re-request the
  // cumulative [from, today]. If this fails, the delta layer regressed; if it
  // passes, the logged cumulative shape came from a stale build or churn, not the
  // steady-state code path.
  it('keeps CONSECUTIVE left-scrolls narrow (no repeated cumulative [from, today])', async () => {
    const today = '20260706';
    const price = { min: 303000, max: 325000 };
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      const from = m ? m[1] : today;
      const to = m ? m[2] : today;
      return {
        ...fakeBundle,
        code: '005930',
        from_date: from,
        to_date: to,
        bucket_ms: 60_000,
        volume_distributions: [
          { date: from, range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] },
        ],
      };
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));
    const options = { mode: 'sidecar' as const, volumeDistributionBins: 10, volumeDistributionPriceRange: price };
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeSidecarDelta('005930', from, today, '1m', undefined, today, options, 'kiwoom_live'),
      { wrapper: makeWrapper(), initialProps: { from: '20260629' } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    rerender({ from: '20260619' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260619'));
    rerender({ from: '20260614' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260614'));

    const urls = spy.mock.calls.map(([u]) => String(u));
    // No SCROLL step may re-request the cumulative window ending at today.
    const cumulativeScroll = urls.filter((u) => /from=2026(0624|0619|0614)&to=20260706/.test(u));
    expect(cumulativeScroll).toEqual([]);
    // Each scroll fetched only its narrow delta tile.
    expect(urls.some((u) => u.includes('from=20260624&to=20260628'))).toBe(true);
    expect(urls.some((u) => u.includes('from=20260619&to=20260623'))).toBe(true);
    expect(urls.some((u) => u.includes('from=20260614&to=20260618'))).toBe(true);
    // The merged bundle still spans back to today.
    expect(result.current.data?.to_date).toBe('20260706');
  });

  // vdist price bounds (derived from today's candle high/low) are NEUTRAL to
  // the delta identity: a mid-scroll churn must keep every step a NARROW tile —
  // the churn step included. (Before the identity fix a churn step fell back to
  // a cumulative [from, today]; with cold seeding that became a seed+walkback
  // re-run — still wasted work. Backend semantics make the exclusion sound:
  // past days bin by their own candle range, the request bounds are only a
  // no-candles fallback.)
  it('a mid-scroll price-range churn stays narrow — identity is vdist-range neutral', async () => {
    const today = '20260706';
    const P1 = { min: 303000, max: 325000 };
    const P2 = { min: 304000, max: 326000 }; // churned once, then stable
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      const from = m ? m[1] : today;
      const to = m ? m[2] : today;
      return { ...fakeBundle, code: '005930', from_date: from, to_date: to, bucket_ms: 60_000 };
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));
    const { result, rerender } = renderHook(
      ({ from, price }: { from: string; price: { min: number; max: number } }) =>
        useRangeSidecarDelta('005930', from, today, '1m', undefined, today, {
          mode: 'sidecar', volumeDistributionBins: 10, volumeDistributionPriceRange: price,
        }, 'kiwoom_live'),
      { wrapper: makeWrapper(), initialProps: { from: '20260629', price: P1 } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624', price: P2 }); // scroll + churn
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    rerender({ from: '20260619', price: P2 }); // scroll, stable
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260619'));
    rerender({ from: '20260614', price: P2 }); // scroll, stable
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260614'));

    const urls = spy.mock.calls.map(([u]) => String(u));
    // churn 스텝(0624+P2)도 좁은 타일 — 새 경계는 URL로 전달되지만 identity는 불변.
    expect(urls.some((u) => u.includes('from=20260624&to=20260628')
      && u.includes('volume_distribution_price_min=304000'))).toBe(true);
    expect(urls.some((u) => u.includes('from=20260619&to=20260623'))).toBe(true);
    expect(urls.some((u) => u.includes('from=20260614&to=20260618'))).toBe(true);
    // 어떤 스텝에서도 누적 [from, today] 재요청 금지.
    expect(urls.filter((u) => /from=2026(0624|0619|0614)&to=20260706/.test(u))).toEqual([]);
  });

  it('does not immediately refresh the today sidecar slice after a delta merge', async () => {
    const first: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260629', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const delta: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260624', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const options = {
      mode: 'sidecar' as const,
      volumeDistributionBins: 10,
      volumeDistributionPriceRange: { min: 303000, max: 325000 },
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      const text = String(url);
      if (text.includes('from=20260624&to=20260628')) return Promise.resolve(delta);
      return Promise.resolve(first);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeSidecarDelta('005930', from, '20260706', '1m', undefined, '20260706', options, 'kiwoom_live'),
      { wrapper, initialProps: { from: '20260629' } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    const deltaRequest = buildRangeBundleRequest({
      code: '005930',
      from: '20260624',
      to: '20260628',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options,
    });
    const deltaOptions = qc.getQueryCache().find({ queryKey: deltaRequest.queryKey })?.options as
      | { refetchInterval?: number | false }
      | undefined;
    expect(deltaOptions?.refetchInterval).toBe(false);
    const todaySidecarUrl = '/api/range?code=005930&from=20260706&to=20260706&bucket_ms=60000'
      + '&volume_distribution_bins=10'
      + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
      + '&source_pref=kiwoom_live&mode=sidecar';
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(todaySidecarUrl);
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/range?code=005930&from=20260624&to=20260706&bucket_ms=60000'
        + '&volume_distribution_bins=10'
        + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
        + '&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
    expect(result.current.data?.volume_distributions.map((d) => d.date)).toEqual(['20260624', '20260629']);
  });

  it('uses compatible query-cache data for sidecar delta planning when the local ref has not observed it', async () => {
    const previous: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260629', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const delta: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260624', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const options = {
      mode: 'sidecar' as const,
      volumeDistributionBins: 10,
      volumeDistributionPriceRange: { min: 303000, max: 325000 },
    };
    const previousRequest = buildRangeBundleRequest({
      code: '005930',
      from: '20260629',
      to: '20260706',
      timeframe: '1m',
      todayKst: '20260706',
      sourcePref: 'kiwoom_live',
      venue: 'KRX',
      options,
    });
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(delta);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    qc.setQueryData(previousRequest.queryKey, previous);
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(
      () =>
        useRangeSidecarDelta('005930', '20260624', '20260706', '1m', undefined, '20260706', options, 'kiwoom_live'),
      { wrapper },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    expect(spy.mock.calls.map(([url]) => String(url))).toContain(
      '/api/range?code=005930&from=20260624&to=20260628&bucket_ms=60000'
        + '&volume_distribution_bins=10'
        + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
        + '&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/range?code=005930&from=20260624&to=20260706&bucket_ms=60000'
        + '&volume_distribution_bins=10'
        + '&volume_distribution_price_min=303000&volume_distribution_price_max=325000'
        + '&source_pref=kiwoom_live&mode=sidecar&venue=KRX',
    );
    expect(result.current.data?.volume_distributions.map((d) => d.date)).toEqual(['20260624', '20260629']);
  });

  it('keeps placeholder query data during forced full requests while the next fetch is pending', async () => {
    const first: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260629', range_count: 10, price_min: 1, price_max: 2, session_open_ms: 1, session_close_ms: 2, bins: [] }],
    };
    const next: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260707',
      bucket_ms: 60_000,
      volume_distributions: [{ date: '20260707', range_count: 10, price_min: 3, price_max: 4, session_open_ms: 3, session_close_ms: 4, bins: [] }],
    };
    let resolveNext!: (value: RangeBundle) => void;
    const nextPending = new Promise<RangeBundle>((resolve) => {
      resolveNext = resolve;
    });
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      String(url).includes('to=20260707') ? nextPending : Promise.resolve(first),
    );
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(
      ({ to }: { to: string }) =>
        useRangeSidecarDelta('005930', '20260629', to, '1m', undefined, to, {
          mode: 'sidecar',
          volumeDistributionBins: 10,
        }, 'kiwoom_live'),
      { wrapper, initialProps: { to: '20260706' } },
    );

    await waitFor(() => expect(result.current.data?.to_date).toBe('20260706'));
    rerender({ to: '20260707' });

    await waitFor(() => expect(spy.mock.calls.some(([url]) => String(url).includes('to=20260707'))).toBe(true));
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(true));
    expect(result.current.data).toEqual(first);

    resolveNext(next);
    await waitFor(() => expect(result.current.isPlaceholderData).toBe(false));
    await waitFor(() => expect(result.current.data?.to_date).toBe('20260707'));
  });
});

describe('useRangeHogaDelta', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('fetches only missing left hoga dates without immediate today refresh after merge', async () => {
    const first: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 2, bid_total: 11, ask_total: 10, bid_max: 5, ask_max: 4, imb_max_bid: 1, imb_max_ask: 0, band_pct: 0, tick: 0 }] },
      fill_strength: { bucket_ms: 60_000, points: [{ t: 2, buy_qty: 3, sell_qty: 1 }] },
    };
    const delta: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      bucket_ms: 60_000,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1, bid_total: 9, ask_total: 10, bid_max: 3, ask_max: 4, imb_max_bid: 0, imb_max_ask: 1, band_pct: 0, tick: 0 }] },
      fill_strength: { bucket_ms: 60_000, points: [{ t: 1, buy_qty: 1, sell_qty: 2 }] },
    };
    const options = { mode: 'hoga' as const };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      const text = String(url);
      if (text.includes('from=20260624&to=20260628')) return Promise.resolve(delta);
      return Promise.resolve(first);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeHogaDelta('005930', from, '20260706', '1m', undefined, '20260706', options, 'kiwoom_live'),
      { wrapper, initialProps: { from: '20260629' } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624' });

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    expect(spy.mock.calls.map(([url]) => String(url))).toContain(
      '/api/range?code=005930&from=20260624&to=20260628&bucket_ms=60000'
        + '&source_pref=kiwoom_live&mode=hoga&venue=KRX',
    );
    const todayHogaUrl = '/api/range?code=005930&from=20260706&to=20260706&bucket_ms=60000'
      + '&source_pref=kiwoom_live&mode=hoga';
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(todayHogaUrl);
    expect(spy.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/range?code=005930&from=20260624&to=20260706&bucket_ms=60000'
        + '&source_pref=kiwoom_live&mode=hoga&venue=KRX',
    );
    expect(result.current.data?.quote_ratio.points.map((p) => p.t)).toEqual([1, 2]);
  });

  it('keeps the deep merged hoga bundle when from narrows to a subset range (no stale-wide refetch)', async () => {
    // aff2ddcf 역전(PR-1, 웜 복귀 패리티): from 이 [0624→0625]로 얕아져도 previous
    // ([0624,0706])는 요청 [0625,0706]의 슈퍼셋(같은 identity·to_date)이라 "stale
    // wide"가 아니라 정확한 딥 서빙이다. historicalFromDate 는 단조 감소만 하므로
    // from 이 얕아지는 유일한 경로는 리셋 후 시드 재파생(=웜 복귀)이고, 종전엔 이때
    // 좁은 창 [0625,0706]을 통짜 재요청하며 딥 지표를 폐기해 캔들만 딥·지표는 얕은
    // 비대칭을 만들었다(사용자 버그). 이제 딥 유지 + 좁은 창 통짜 요청 부재.
    const first: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260629',
      to_date: '20260706',
      bucket_ms: 60_000,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 2, bid_total: 11, ask_total: 10, bid_max: 5, ask_max: 4, imb_max_bid: 1, imb_max_ask: 0, band_pct: 0, tick: 0 }] },
    };
    const delta: RangeBundle = {
      ...fakeBundle,
      code: '005930',
      from_date: '20260624',
      to_date: '20260628',
      bucket_ms: 60_000,
      quote_ratio: { bucket_ms: 60_000, points: [{ t: 1, bid_total: 9, ask_total: 10, bid_max: 3, ask_max: 4, imb_max_bid: 0, imb_max_ask: 1, band_pct: 0, tick: 0 }] },
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) => {
      const text = String(url);
      if (text.includes('from=20260624&to=20260628')) return Promise.resolve(delta);
      return Promise.resolve(first);
    });
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeHogaDelta('005930', from, '20260706', '1m', undefined, '20260706', { mode: 'hoga' }, 'kiwoom_live'),
      { wrapper, initialProps: { from: '20260629' } },
    );

    await waitFor(() => expect(result.current.data?.from_date).toBe('20260629'));
    rerender({ from: '20260624' });
    await waitFor(() => expect(result.current.data?.from_date).toBe('20260624'));
    expect(result.current.data?.quote_ratio.points.map((p) => p.t)).toEqual([1, 2]);

    rerender({ from: '20260625' });
    // 얕아진 뒤에도 딥([0624], qr [1,2]) 유지 — 좁은 창을 새로 받지 않는다.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(result.current.data?.from_date).toBe('20260624');
    expect(result.current.data?.quote_ratio.points.map((p) => p.t)).toEqual([1, 2]);
    const urls = spy.mock.calls.map(([url]) => String(url));
    expect(urls.some((u) => /from=20260625&to=20260706/.test(u))).toBe(false);
  });
});

describe('rangeFreshnessOptions (review C1 — pastMaxQrT advance)', () => {
  const today = '20260607';

  // 오늘 분기는 탭 가림 중에도 폴링을 유지하고(refetchIntervalInBackground) 복귀
  // 시 즉시 재조회한다(refetchOnWindowFocus). 2026-07-29 조사: 두 플래그가 없으면
  // 탭이 가려진 동안 5분 폴링이 멈춰 pastMaxQrT 가 동결되고, 오늘 보조지표가
  // 15분 SSE 버퍼만으로 남다가 축출과 함께 구멍이 난다.
  const LIVE_HEAD = { refetchIntervalInBackground: true, refetchOnWindowFocus: true };
  const FROZEN = { refetchIntervalInBackground: false, refetchOnWindowFocus: false };

  it('sets the 5-min refetch when the range includes today (to === today)', () => {
    // /live always requests `to = today`, so this is the live-call branch.
    expect(rangeFreshnessOptions(today, today)).toEqual({
      staleTime: TODAY_RANGE_REFETCH_MS,
      refetchInterval: TODAY_RANGE_REFETCH_MS,
      ...LIVE_HEAD,
    });
  });

  it('sets the 5-min refetch when the range extends past today (to > today)', () => {
    expect(rangeFreshnessOptions('20260610', today)).toEqual({
      staleTime: TODAY_RANGE_REFETCH_MS,
      refetchInterval: TODAY_RANGE_REFETCH_MS,
      ...LIVE_HEAD,
    });
  });

  it('freezes (Infinity, no refetch) for a past-only range (to < today)', () => {
    expect(rangeFreshnessOptions('20260606', today)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
      ...FROZEN,
    });
  });

  it('freezes when no todayKst is given — non-live callers stay frozen', () => {
    // capture/replay backfill omit todayKst entirely; the refetch must not leak.
    // 배경 폴링·focus 재조회도 같이 막혀야 한다 — 셋 다 켜지면 과거 전용 호출자가
    // 조용히 라이브 유량을 타게 된다.
    expect(rangeFreshnessOptions('20260606', null)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
      ...FROZEN,
    });
  });

  it('freezes when to is null (query disabled)', () => {
    expect(rangeFreshnessOptions(null, today)).toEqual({
      staleTime: Infinity,
      refetchInterval: false,
      ...FROZEN,
    });
  });
});

describe('rangePlaceholderData', () => {
  const baseKey: Parameters<typeof rangePlaceholderData>[1] = [
    'range',
    '005930',
    '20260512',
    '20260512',
    60_000,
    undefined,
    undefined,
    null,
    930,
    null,
    undefined,
    undefined,
    null,
    'kiwoom_live',
    'hoga',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'KRX',
  ];

  it('keeps previous same-code data for date extension when option-sensitive fields are unchanged', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260510',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      930,
      null,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBe(fakeBundle);
  });

  it('drops previous broker late-entry events when the threshold option changes', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      945,
      null,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBeUndefined();
  });

  it('drops previous sidecar data when the volume distribution cutoff changes', () => {
    const previousKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      null,
      10,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'sidecar',
      1_772_000_001_000,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ];
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      null,
      10,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'sidecar',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'KRX',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, previousKey)).toBeUndefined();
  });

  // ADR-0140 은 venue 를 캐시 키에 넣어 "거래소를 바꿔도 이전 데이터가 보이는" 것을
  // 막았는데, placeholder 경로만 그 인덱스를 비교하지 않아 뚫려 있었다 — 새 응답이
  // 도착할 때까지 **이전 거래소의 과거 지표가 새 venue 화면에 뜬다**.
  it('drops previous data when the venue changes', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      930,
      null,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      'NXT', // ← baseKey 는 'KRX'
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBeUndefined();
  });

  // depth_delta 토글은 화면 증상이 없다 — pane 렌더 게이트가 번들이 아니라 스토어
  // 플래그(`useWindowIndicator`)라 옛 데이터가 placeholder 에 남아도 그려지지 않는다.
  // 그래도 "placeholder 는 옵션이 같은 사본" 이라는 계약은 지켜야 한다: 바로 옆
  // 히트맵(idx 20)이 그렇게 하고 있고, 둘의 비대칭은 의도가 아니라 갱신 누락이었다.
  it('drops previous data when the depth delta toggle changes', () => {
    const currentKey: Parameters<typeof rangePlaceholderData>[1] = [
      'range',
      '005930',
      '20260512',
      '20260512',
      60_000,
      undefined,
      undefined,
      null,
      930,
      null,
      undefined,
      undefined,
      null,
      'kiwoom_live',
      'hoga',
      null,
      null,
      null,
      null,
      null,
      null,
      true, // ← baseKey 는 null
      'KRX',
    ];

    expect(rangePlaceholderData(fakeBundle, currentKey, baseKey)).toBeUndefined();
  });
});

describe('좌측 팬 중 range 캐시 사본 누적', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('팬 스텝마다 재발행해도 지배당한 사본은 남지 않고 최심 복원원은 유지된다', async () => {
    const today = '20260706';
    const bundleFor = (url: unknown): RangeBundle => {
      const m = String(url).match(/from=(\d+)&to=(\d+)/);
      return {
        ...fakeBundle,
        code: '005930',
        from_date: m ? m[1] : today,
        to_date: m ? m[2] : today,
        bucket_ms: 60_000,
      };
    };
    vi.spyOn(client, 'apiCall').mockImplementation((url) => Promise.resolve(bundleFor(url)));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc);  // 심볼 요청이 apiCall 모킹 큐를 먹지 않게 (makeWrapper 주석 참조)
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    // 사용자가 차트를 왼쪽으로 계속 미는 상황 — historicalFromDate 가 스텝마다
    // 뒤로 밀리므로 훅의 from 이 바뀌고, 그때마다 base 키가 **새로** 생긴다.
    const steps = ['20260629', '20260622', '20260615', '20260608', '20260601'];
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useRangeSidecarDelta('005930', from, today, '1m', undefined, today, {
          mode: 'sidecar',
          volumeDistributionBins: 10,
        }, 'kiwoom_live'),
      { wrapper, initialProps: { from: steps[0] } },
    );

    for (const from of steps) {
      rerender({ from });
      await waitFor(() => expect(result.current.data?.from_date).toBe(from), { timeout: 5000 });
    }

    const cached = qc.getQueryCache()
      .findAll({ queryKey: ['range', '005930'] })
      .map((q) => q.state.data as RangeBundle | undefined)
      .filter((d): d is RangeBundle => !!d);
    const wideCopies = cached.filter((d) => d.to_date === today);

    console.log('[dominated] 전체 =', cached.length, '| to=today 사본 =', wideCopies.length,
      wideCopies.map((d) => `${d.from_date}~${d.to_date}`).join(' '));

    // to_date=today 인 "최광폭 병합본" 사본은 스텝 수만큼 쌓이면 안 된다. 가드가 없으면
    // 스텝마다 한 벌씩(각각 그 시점의 전체 번들) 남아 힙을 그대로 갉아먹는다.
    expect(wideCopies.length).toBe(1);
    // 그리고 남은 한 벌은 반드시 최심(=팬 끝까지 확장된) 복원원이어야 한다.
    expect(wideCopies[0].from_date).toBe('20260601');
  });
});

// ── 종목별 유효 venue 해석 (#1213 자매 — 스팟 훅이 아니라 range 계열) ──────────
//
// `/live` 의 venue 해석은 `effectiveLiveVenue` 한 곳이다(UN + NXT 미상장 → KRX).
// 이 훅들은 전역 선택값을 그대로 URL·queryKey 에 넣고 있었다. 백엔드는 흡수하지
// 않는다 — NXT 미상장 종목엔 `kiwoom_live/UN/` 이 애초에 안 생겨 **빈 200** 이
// 오고, 에러가 아니라 정상 빈 응답이라 화면이 조용히 빈다.
describe('range 훅 — 종목별 유효 venue 해석', () => {
  function seededWrapper(hits: SymbolHit[]) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seedSymbolMaster(qc, hits);
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    // zustand 는 모듈 상태라 앞 테스트의 선택이 남는다 — 명시적으로 되돌린다.
    useLiveVenueStore.setState({ venue: 'KRX' });
  });

  it('useRange: NXT 미상장 + 통합 선택이면 KRX 로 조회한다', async () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('003490', '20260807', '20260807', '1m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: seededWrapper([symbolHit('003490', false)]) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][0]).toContain('venue=KRX');
  });

  it('useRange: NXT 상장 종목이면 통합 선택을 그대로 쓴다', async () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('005930', '20260807', '20260807', '1m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: seededWrapper([symbolHit('005930', true)]) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][0]).toContain('venue=UN');
  });

  it('useRange: nxt_enabled 를 모르면 강등하지 않는다', async () => {
    // 백엔드가 모름을 fail-open 으로 세 venue 전부 구독하므로 UN 프레임이 실제로
    // 존재한다(coverage.py). 프론트만 강등하면 있는 데이터를 버린다.
    useLiveVenueStore.setState({ venue: 'UN' });
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    const { result } = renderHook(
      () => useRange('005930', '20260807', '20260807', '1m', undefined, undefined, { mode: 'hoga' }),
      { wrapper: seededWrapper([symbolHit('005930', null)]) },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(spy.mock.calls[0][0]).toContain('venue=UN');
  });

  it('useRangeSidecarDelta: 델타 경로도 같은 해석을 탄다', async () => {
    // 델타는 `liveRangeDeltaIdentity`(queryKey 파생)까지 venue 를 물고 가므로,
    // 선택값이 남으면 venue 를 바꿔도 병합본이 이전 시장 데이터를 유지한다.
    useLiveVenueStore.setState({ venue: 'UN' });
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(fakeBundle);
    renderHook(
      () => useRangeSidecarDelta('003490', '20260807', '20260807', '1m', undefined, '20260807', {
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: { min: 1, max: 2 },
      }, 'kiwoom_live'),
      { wrapper: seededWrapper([symbolHit('003490', false)]) },
    );
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.every((c) => String(c[0]).includes('venue=KRX'))).toBe(true);
  });
});
