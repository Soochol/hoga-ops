/**
 * useLiveChartData — workarea 파생값의 **소스 선택** 계약.
 *
 * 이 파일이 지키는 것은 하나다: 라이브 성분이 필요한 값은 병합 번들(`bundle`)에서
 * 오고, 성능 분기로 갈라 둔 `chartBundle`(= SSE 틱에 안 변하는 절반, sidecar 원본)
 * 에서 오지 않는다. 2026-08-04 회귀에서 히트맵이 정확히 이 선택을 잘못해 디스크 승격
 * 주기(5분)로만 갱신됐다 — `useLiveBundle` 쪽 테스트는 두 번들을 각각 검사할 뿐
 * **소비처가 어느 쪽을 집는지**는 보지 않아 전부 초록이었다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { RangeBundle } from '../api/types';
import type { LiveSeriesData } from '../api/liveSeries';

const liveFixture: LiveSeriesData = {
  initial: undefined,
  isLoading: false,
  error: null,
  ob: [],
  trade: [],
  broker: [],
  program: [],
  afterHours: [],
};

/** sidecar 원본에만 있는 과거 버킷. */
const PAST_POINT = { t_ms: 100, asks: [[70_100, 500]], bids: [[70_000, 400]] };
/** 라이브 래칫이 오늘 버킷으로 덧씌운 것 — 병합 번들에만 있다. */
const LIVE_POINT = { t_ms: 1_779_840_060_000, asks: [[70_100, 900]], bids: [[70_000, 800]] };

function bundleWith(depthHeatmap: unknown[]): RangeBundle {
  return {
    code: '005930',
    from_date: '20260520',
    to_date: '20260527',
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
    bid_peaks: [],
    broker_late_entries: [],
    price_level_hits: [],
    trade_volume_pocs: [],
    program_trade: { points: [] },
    depth_heatmap: depthHeatmap,
  } as unknown as RangeBundle;
}

// 병합 번들 = 과거 + 오늘(라이브). chartBundle = sidecar 원본(과거만).
const MERGED_BUNDLE = bundleWith([PAST_POINT, LIVE_POINT]);
const SIDECAR_ONLY_BUNDLE = bundleWith([PAST_POINT]);

const BUNDLE_RESULT = {
  bundle: MERGED_BUNDLE as RangeBundle | null,
  chartBundle: SIDECAR_ONLY_BUNDLE as RangeBundle | null,
  hogaBundle: SIDECAR_ONLY_BUNDLE as RangeBundle | null,
  depthDeltaToday: [],
  clampEngaged: false,
  isLoading: false,
  error: null,
  isPastCandlesLoading: false,
  isHogaLoading: false,
  isExtending: false,
  isSidecarLoading: false,
  pastDataWarnings: [],
  indicatorCoverageFromDate: null,
  rangeWindowFromDate: null,
};

const useLiveBundleSpy = vi.fn(() => BUNDLE_RESULT);

vi.mock('./useLiveBundle', () => ({
  useLiveBundle: (...args: unknown[]) => (useLiveBundleSpy as (...a: unknown[]) => unknown)(...args),
}));
vi.mock('../api/liveSeries', () => ({ useLiveSeries: () => liveFixture }));
vi.mock('./useDayAskPeaks', () => ({
  useDayAskPeaks: () => [],
  useTodayAllPriceAskPeak: () => null,
}));
vi.mock('./useDayBidPeaks', () => ({
  useDayBidPeaks: () => [],
  useTodayAllPriceBidPeak: () => null,
}));
vi.mock('./useTradeVolumePoc', () => ({ useTradeVolumePocs: () => [] }));
vi.mock('../api/liveIndices', () => ({
  useLiveIndexCandles: () => ({ data: undefined, isLoading: false, isFetching: false }),
  useLiveIndexInvestorNet: () => ({ data: undefined }),
}));
vi.mock('./indicators/useDailyMaRevealGate', () => ({ useDailyMaRevealGate: () => false }));

const { useLiveChartData } = await import('./useLiveChartData');

function renderForStock() {
  return renderHook(() =>
    useLiveChartData({
      activeCode: '005930',
      activeInstrument: { kind: 'stock', code: '005930', label: '삼성전자' },
      timeframe: '1m',
      historicalFromDate: null,
      venue: 'KRX',
      investorNetEnabled: false,
    }),
  );
}

describe('useLiveChartData — depth heatmap source', () => {
  beforeEach(() => {
    useLiveBundleSpy.mockReset();
    useLiveBundleSpy.mockReturnValue(BUNDLE_RESULT);
  });

  it('오버레이 소스는 병합 번들에서 온다 (chartBundle 아님)', () => {
    const { result } = renderForStock();

    // 라이브 버킷이 살아 있어야 한다 — chartBundle 을 집었다면 과거 1개만 남는다.
    expect(result.current.workareaDepthHeatmap).toEqual([PAST_POINT, LIVE_POINT]);
    expect(result.current.workareaDepthHeatmap).toBe(MERGED_BUNDLE.depth_heatmap);
    expect(result.current.workareaDepthHeatmap).not.toBe(SIDECAR_ONLY_BUNDLE.depth_heatmap);
  });

  it('저장 뷰 번들의 히트맵도 병합 번들에서 온다', () => {
    const { result } = renderForStock();

    // liveSaveBundle 의 나머지 필드는 chartBundle(=extending 홀드 대상)을 따르지만
    // depth_heatmap 만은 화면에 그려진 것과 같아야 한다.
    expect(result.current.liveSaveBundle?.depth_heatmap).toEqual([PAST_POINT, LIVE_POINT]);
  });

  it('번들이 없으면 안정 빈 배열을 준다 (렌더마다 새 [] 금지)', () => {
    useLiveBundleSpy.mockReturnValue({
      ...BUNDLE_RESULT,
      bundle: null,
      chartBundle: null,
      hogaBundle: null,
    });

    const { result, rerender } = renderForStock();
    const first = result.current.workareaDepthHeatmap;
    rerender();

    expect(first).toEqual([]);
    // 참조가 흔들리면 LiveChartRoot 의 depthHeatmapFromWire memo 가 매 렌더 깨진다.
    expect(result.current.workareaDepthHeatmap).toBe(first);
  });
});
