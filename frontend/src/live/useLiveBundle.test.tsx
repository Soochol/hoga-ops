import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { overlayLiveTradesOnCandles, planLiveRangeRequest, useLiveBundle } from './useLiveBundle';
import { mergeDepthHeatmapToday } from './depthHeatmapWire';
import { LIVE_SETTINGS_KEY, type LiveSettings } from '../api/liveSettings';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';
import { useKisRestModeStore } from '../state/kisRestMode';
import type { LiveSeriesData } from '../api/liveSeries';
import { createVirtualAxis } from '../util/virtualAxis';
import { projectVolume } from '../chart/projectors/volume';

// Live fixture — used to be a mock of useLiveSeries when useLiveBundle owned
// the hook call. After the LivePage-lift refactor, `live` is a prop passed
// straight through; tests construct it inline.
const liveFixture: LiveSeriesData = {
  initial: {
    code: '005930',
    date: '20260527',
    session_open_ms: 1779840000000,
    session_close_ms: 1779863400000,
    is_open: true,
    snapshots: [],
    trades: [],
    brokers: [],
    ask_peak_today: null,
    bid_peak_today: null,
  },
  isLoading: false,
  error: null,
  ob: [
    { t_ms: 1779840060000, total_ask_qty: 100, total_bid_qty: 80, kind: 'ob' },
  ],
  trade: [],
  broker: [],
};

const DEFAULT_CANDLE = { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 };
// Mutable per-test control over the candle query's data + react-query flags so
// the extension-atomization gate (isPlaceholderData / isFetching) is testable.
const candlesMock = {
  candles: [DEFAULT_CANDLE] as Array<typeof DEFAULT_CANDLE>,
  isPlaceholderData: false,
  isFetching: false,
  warnings: [] as Array<{ date?: string; reason: string; msg: string }>,
  effectiveSessions: [] as Array<{ date: string; venue: 'KRX' | 'NXT' | 'UN'; open_ms: number; close_ms: number }>,
};
const livePastCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    candles: candlesMock.candles,
    cached_dates: [],
    fresh_dates: [],
    data_warnings: candlesMock.warnings,
    effective_sessions: candlesMock.effectiveSessions,
  },
  isLoading: false,
  error: null,
  isPlaceholderData: candlesMock.isPlaceholderData,
  isFetching: candlesMock.isFetching,
}));
vi.mock('../api/livePastCandles', () => ({
  useLivePastCandles: (...args: unknown[]) => livePastCandlesSpy(...args as []),
}));

const dailyCandlesMock = {
  candles: [
    { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
  ],
  warnings: [] as Array<{ date?: string; reason: string; msg: string }>,
};
const livePastDailyCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    candles: dailyCandlesMock.candles,
    cached_batches: [],
    fresh_batches: [],
    data_warnings: dailyCandlesMock.warnings,
  },
  isLoading: false,
  error: null,
}));
vi.mock('../api/livePastDailyCandles', () => ({
  useLivePastDailyCandles: (...args: unknown[]) => livePastDailyCandlesSpy(...args as []),
}));

const screenerDailyCandlesMock = {
  candles: [] as Array<typeof DEFAULT_CANDLE>,
};
const screenerDailyCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    source: 'screener_daily',
    candles: screenerDailyCandlesMock.candles,
  },
  isLoading: false,
  error: null,
}));
vi.mock('../api/screenerDailyCandles', () => ({
  useScreenerDailyCandles: (...args: unknown[]) => screenerDailyCandlesSpy(...args as []),
}));

const investorMock = {
  isLoading: false,
  points: [] as Array<{ t_ms: number; foreign_net: number; institution_net: number }>,
};
const livePastInvestorNetSpy = vi.fn(() => ({
  data: { points: investorMock.points },
  isLoading: investorMock.isLoading,
  error: null,
}));
vi.mock('../api/livePastInvestorNet', () => ({
  useLivePastInvestorNet: (...args: unknown[]) => livePastInvestorNetSpy(...args as []),
}));

const rangeMock = { isPlaceholderData: false, isFetching: false, isHistoricalDeltaFetching: false };
const useRangeSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
  isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
}));
const useRangeHogaDeltaSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
  isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
}));
const useRangeSidecarDeltaSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
  isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
}));
vi.mock('../api/range', () => ({
  useRange: (...args: unknown[]) => useRangeSpy(...args as []),
  useRangeHogaDelta: (...args: unknown[]) => useRangeHogaDeltaSpy(...args as []),
  useRangeSidecarDelta: (...args: unknown[]) => useRangeSidecarDeltaSpy(...args as []),
}));

function rangeResult(data: unknown = null) {
  return { data, isLoading: false, error: null, isPlaceholderData: false, isFetching: false, isHistoricalDeltaFetching: false };
}

function fallbackRangeBundle(close = 71_234) {
  return {
    code: '005930',
    from_date: '20260520',
    to_date: '20260527',
    bucket_ms: 60_000,
    segments: [
      {
        date: '20260527',
        session_open_ms: 1_779_840_000_000,
        session_close_ms: 1_779_863_400_000,
        source: 'hogaplay',
      },
    ],
    candles: [
      { ts_ms: 1_779_840_000_000, open: 71_000, high: 71_300, low: 70_900, close, vol_a: 1000, vol_b: 0 },
    ],
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
  };
}

function createWrapper(settings?: Partial<LiveSettings>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(LIVE_SETTINGS_KEY, {
    schema_version: 1,
    storage_policy: 'ws_plus_rest',
    program_trade_storage_enabled: false,
    kis_rest_bypass_enabled: false,
    ...settings,
  } satisfies LiveSettings);
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const wrapper = createWrapper();

function renderUseLiveBundle(
  overrides: {
    code?: string | null;
    timeframe?: '1m' | 'D';
    settings?: Partial<LiveSettings>;
    rangeCandles?: Array<{ ts_ms: number; open: number; high: number; low: number; close: number; vol_a: number; vol_b: number }>;
    screenerDailyCandles?: Array<{ t_ms: number; open: number; high: number; low: number; close: number; volume: number }>;
  } = {},
) {
  const {
    code = '005930',
    timeframe = '1m',
    settings,
    rangeCandles = [],
    screenerDailyCandles = [],
  } = overrides;
  screenerDailyCandlesMock.candles = screenerDailyCandles;
  const previousImplementation = useRangeSpy.getMockImplementation();
  useRangeSpy.mockImplementation((...args: unknown[]) => {
    const options = args[6] as { mode?: string } | undefined;
    if (options?.mode === 'candles' || options?.mode === 'full') {
      return rangeResult(rangeCandles.length > 0 ? {
        ...fallbackRangeBundle(rangeCandles[rangeCandles.length - 1]?.close ?? 71_234),
        candles: rangeCandles,
      } : null);
    }
    return rangeResult();
  });
  const rendered = renderHook(
    () => useLiveBundle(code, timeframe, '20260527', liveFixture),
    { wrapper: createWrapper(settings) },
  );
	  useRangeSpy.mockImplementation(previousImplementation ?? (() => ({
	    data: null,
	    isLoading: false,
	    error: null,
	    isPlaceholderData: rangeMock.isPlaceholderData,
	    isFetching: rangeMock.isFetching,
	    isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
	  })));
  return rendered.result.current;
}

describe('planLiveRangeRequest', () => {
  it('plans the minute /api/range request with indicator-controlled optional slices', () => {
    expect(planLiveRangeRequest({
      code: '005930',
      timeframe: '1m',
      todayKstYyyymmdd: '20260527',
      historicalFromDate: '20260501',
      askPeakEnabled: false,
      bidPeakEnabled: true,
      tradeVolumePocEnabled: true,
      depthHeatmapEnabled: true,
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 945,
      programTradeEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 12,
      volumeDistributionPriceRange: { min: 69900, max: 70100 },
    })).toEqual({
      code: '005930',
      from: '20260501',
      to: '20260527',
      timeframe: '1m',
      todayKst: '20260527',
      options: {
        askPeaksEnabled: false,
        bidPeaksEnabled: true,
        brokerLateEntriesEnabled: true,
        brokerLateEntryStartHHMM: 945,
        programTradeEnabled: true,
        tradeVolumePocEnabled: true,
        depthHeatmapEnabled: true,
        volumeDistributionBins: 12,
        tradeVolumePocBins: 12,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      },
    });
  });

  it('disables /api/range for calendar timeframes and gates disabled optional slices', () => {
    expect(planLiveRangeRequest({
      code: '005930',
      timeframe: 'D',
      todayKstYyyymmdd: '20260527',
      historicalFromDate: '20200101',
      askPeakEnabled: true,
      bidPeakEnabled: true,
      tradeVolumePocEnabled: false,
      depthHeatmapEnabled: true,
      brokerLateEntryEnabled: false,
      brokerLateEntryStartHHMM: 945,
      programTradeEnabled: true,
      volumeDistributionEnabled: false,
      volumeDistributionRangeCount: 12,
      volumeDistributionPriceRange: { min: 69900, max: 70100 },
    })).toEqual({
      code: null,
      from: null,
      to: null,
      timeframe: null,
      todayKst: null,
      options: {
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        brokerLateEntriesEnabled: false,
        brokerLateEntryStartHHMM: null,
        programTradeEnabled: false,
        tradeVolumePocEnabled: false,
        depthHeatmapEnabled: false,
        volumeDistributionBins: null,
        tradeVolumePocBins: null,
        volumeDistributionPriceRange: null,
      },
    });
  });
});

describe('overlayLiveTradesOnCandles', () => {
  it('reuses the input candle array when trades cannot affect the visible tail', () => {
    const candles = [
      { ts_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, vol_a: 1000, vol_b: 0 },
    ];

    const out = overlayLiveTradesOnCandles(candles, [
      {
        t_ms: 1779839940000,
        kind: 'trade',
        trades: [{ t_ms: 1779839940000, price: 80000, qty: 99, side: 1 }],
      },
    ], 60_000);

    expect(out).toBe(candles);
  });

  it('keeps historical candle objects stable when updating the current bucket', () => {
    const first = { ts_ms: 1779839940000, open: 69900, high: 70000, low: 69800, close: 70000, vol_a: 500, vol_b: 0 };
    const last = { ts_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, vol_a: 1000, vol_b: 0 };
    const candles = [first, last];

    const out = overlayLiveTradesOnCandles(candles, [
      {
        t_ms: 1779840030000,
        kind: 'trade',
        trades: [{ t_ms: 1779840030000, price: 70150, qty: 7, side: 1 }],
      },
    ], 60_000);

    expect(out).not.toBe(candles);
    expect(out[0]).toBe(first);
    expect(out[1]).not.toBe(last);
    expect(out[1]).toMatchObject({ high: 70150, close: 70150, vol_a: 1007 });
  });
});

describe('mergeDepthHeatmapToday', () => {
  const pastBucket = {
    t_ms: 100,
    asks: [[70_100, 500]] as [number, number][],
    bids: [[70_000, 400]] as [number, number][],
  };

  it('keeps past-only wire buckets and appends today domain buckets (ascending)', () => {
    const merged = mergeDepthHeatmapToday([pastBucket], [
      {
        tMs: 200,
        asks: [{ price: 70_200, qty: 300 }],
        bids: [{ price: 69_900, qty: 200 }],
        asksMax: [{ price: 70_200, qty: 350 }],
        bidsMax: [{ price: 69_900, qty: 250 }],
      },
    ]);

    expect(merged.map((p) => p.t_ms)).toEqual([100, 200]);
    // past passes through untouched (same reference)
    expect(merged[0]).toBe(pastBucket);
    // today domain → wire (camelCase levels → [price, qty] pairs incl. *_max)
    expect(merged[1]).toEqual({
      t_ms: 200,
      asks: [[70_200, 300]],
      bids: [[69_900, 200]],
      asks_max: [[70_200, 350]],
      bids_max: [[69_900, 250]],
    });
  });

  it('lets today (live) win when a t_ms exists in both past and today', () => {
    const merged = mergeDepthHeatmapToday([pastBucket], [
      {
        tMs: 100,
        asks: [{ price: 70_100, qty: 999 }],
        bids: [{ price: 70_000, qty: 888 }],
        asksMax: [{ price: 70_100, qty: 999 }],
        bidsMax: [{ price: 70_000, qty: 888 }],
      },
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual({
      t_ms: 100,
      asks: [[70_100, 999]],
      bids: [[70_000, 888]],
      asks_max: [[70_100, 999]],
      bids_max: [[70_000, 888]],
    });
  });

  it('handles an empty/undefined past (today-only) and empty today (past-only)', () => {
    expect(mergeDepthHeatmapToday(undefined, [])).toEqual([]);
    expect(mergeDepthHeatmapToday([pastBucket], [])).toEqual([pastBucket]);
    expect(
      mergeDepthHeatmapToday(undefined, [
        { tMs: 300, asks: [], bids: [], asksMax: [], bidsMax: [] },
      ]),
    ).toEqual([{ t_ms: 300, asks: [], bids: [], asks_max: [], bids_max: [] }]);
  });
});

describe('useLiveBundle', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastCandlesSpy.mockImplementation(() => ({
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: candlesMock.candles,
        cached_dates: [],
        fresh_dates: [],
        data_warnings: candlesMock.warnings,
        effective_sessions: candlesMock.effectiveSessions,
      },
      isLoading: false,
      error: null,
      isPlaceholderData: candlesMock.isPlaceholderData,
      isFetching: candlesMock.isFetching,
    }));
    livePastDailyCandlesSpy.mockClear();
    livePastInvestorNetSpy.mockClear();
    useRangeSpy.mockClear();
    useRangeHogaDeltaSpy.mockClear();
    useRangeSidecarDeltaSpy.mockClear();
	    useRangeSpy.mockImplementation(() => ({
	      data: null,
	      isLoading: false,
	      error: null,
	      isPlaceholderData: rangeMock.isPlaceholderData,
	      isFetching: rangeMock.isFetching,
	      isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
	    }));
	    useRangeSidecarDeltaSpy.mockImplementation(() => ({
	      data: null,
	      isLoading: false,
	      error: null,
	      isPlaceholderData: rangeMock.isPlaceholderData,
	      isFetching: rangeMock.isFetching,
	      isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
	    }));
	    useRangeHogaDeltaSpy.mockImplementation(() => ({
	      data: null,
	      isLoading: false,
	      error: null,
	      isPlaceholderData: rangeMock.isPlaceholderData,
	      isFetching: rangeMock.isFetching,
	      isHistoricalDeltaFetching: rangeMock.isHistoricalDeltaFetching,
	    }));
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
    candlesMock.effectiveSessions = [];
    dailyCandlesMock.candles = [
      { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ];
    dailyCandlesMock.warnings = [];
    rangeMock.isPlaceholderData = false;
    rangeMock.isFetching = false;
    investorMock.isLoading = false;
    investorMock.points = [];
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
      tradeVolumePocEnabled: true,
      volumeDistributionEnabled: true,
      volumeDistributionRangeCount: 10,
      askPeakEnabled: false,
      bidPeakEnabled: false,
      programTradeEnabled: true,
      brokerLateEntryEnabled: false,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
    useKisRestModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
    });
  });

  it('builds a today-only bundle when historicalFromDate is null', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.bundle!.segments.length).toBe(1);
    expect(result.current.bundle!.segments[0].source).toBe('kis_live');
    expect(result.current.bundle!.candles.length).toBe(1);
    expect(result.current.bundle!.quote_ratio.points.length).toBe(1);
  });

  it('returns null bundle when code is null', () => {
    const { result } = renderHook(() => useLiveBundle(null, '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.bundle).toBeNull();
    expect(result.current.chartBundle).toBeNull();
  });

  it('holds hoga series empty while the cold minute candle load is pending (UN 대량 시간점 삽입 크래시 가드)', () => {
    // 콜드: past-candles 미settle. 이때 SSE-유래 hoga 포인트가 캔들보다 먼저 커밋되면
    // 공유 timeScale에 캔들이 뒤늦게 대량 삽입되며 lwc 내부가 깨진다(2026-07-08 UN 크래시).
    livePastCandlesSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
    } as unknown as ReturnType<typeof livePastCandlesSpy>));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.bundle!.quote_ratio.points).toEqual([]);
    expect(result.current.bundle!.fill_strength.points).toEqual([]);
    expect(result.current.hogaBundle!.quote_ratio.points).toEqual([]);
  });

  it('releases the held hoga series once the candle query settles', () => {
    livePastCandlesSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
    } as unknown as ReturnType<typeof livePastCandlesSpy>));
    const { result, rerender } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.bundle!.quote_ratio.points).toEqual([]);
    livePastCandlesSpy.mockImplementation(() => ({
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: candlesMock.candles,
        cached_dates: [],
        fresh_dates: [],
        data_warnings: [],
        effective_sessions: [],
      },
      isLoading: false,
      error: null,
      isPlaceholderData: false,
      isFetching: false,
    }));
    rerender();
    expect(result.current.bundle!.quote_ratio.points.length).toBe(1);
    expect(result.current.bundle!.candles.length).toBe(1);
  });

  it('exposes hogaCoverageGapDates for past candle dates the hoga bundle does not cover', () => {
    // 캔들: 과거일(20260526)+오늘(20260527), hoga 번들: 오늘만 커버 → 갭 = 과거일만.
    candlesMock.candles = [
      { t_ms: 1_779_753_600_000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
      DEFAULT_CANDLE,
    ];
    useRangeHogaDeltaSpy.mockImplementation(() => rangeResult(fallbackRangeBundle()));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.hogaCoverageGapDates).toEqual(['20260526']);
  });

  it('keeps hogaCoverageGapDates empty while the hoga bundle has not loaded (판정 유보)', () => {
    candlesMock.candles = [
      { t_ms: 1_779_753_600_000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
      DEFAULT_CANDLE,
    ];
    // 기본 useRangeHogaDelta mock: data null (미로드).
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.hogaCoverageGapDates).toEqual([]);
  });

  it('reports isHogaLoading while the hoga range delta is pending with no data (cold minute load)', () => {
    useRangeHogaDeltaSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
      isHistoricalDeltaFetching: false,
    }));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isHogaLoading).toBe(true);
  });

  it('clears isHogaLoading once the hoga range delta settles', () => {
    // Default beforeEach mock: hoga delta settled (isLoading false).
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isHogaLoading).toBe(false);
  });

  it('does not hold isHogaLoading on a warm switch-back (data present while a refresh is loading)', () => {
    // cachedLiveRangeDeltaPrevious serves the merged bundle instantly while the
    // today-only refresh delta re-keys as isLoading; the `data == null` term
    // releases the hold so the cover does not wedge over a fully-drawn chart.
    useRangeHogaDeltaSpy.mockImplementation(() => ({
      data: fallbackRangeBundle(71_500),
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
      isHistoricalDeltaFetching: false,
    }));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isHogaLoading).toBe(false);
  });

  it('reports isSidecarLoading while the sidecar delta is pending with no data (개선안 1-A)', () => {
    // beforeEach enables tradeVolumePoc/volumeDistribution/programTrade → sidecarEnabled.
    useRangeSidecarDeltaSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
      isHistoricalDeltaFetching: false,
    }));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isSidecarLoading).toBe(true);
  });

  it('clears isSidecarLoading once the sidecar delta settles', () => {
    // Default beforeEach mock: sidecar delta settled (isLoading false).
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isSidecarLoading).toBe(false);
  });

  it('does not hold isSidecarLoading when no sidecar indicator is enabled (sidecarEnabled=false)', () => {
    useLivePageStore.setState({
      tradeVolumePocEnabled: false,
      volumeDistributionEnabled: false,
      programTradeEnabled: false,
      askPeakEnabled: false,
      bidPeakEnabled: false,
      brokerLateEntryEnabled: false,
    });
    useRangeSidecarDeltaSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
      isHistoricalDeltaFetching: false,
    }));
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    expect(result.current.isSidecarLoading).toBe(false);
  });

  it('splits the candle side (chartBundle) from the live hoga overlay (bundle)', () => {
    // Bundle-split (2026-06-09, Phase A): candle/volume/axis read `chartBundle`
    // (no ob/trade deps → stable across SSE ticks); hoga panes read the full
    // `bundle`. Both share candles + segments refs so the VirtualAxis stays
    // single-build; chartBundle carries only an empty hoga stub.
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });
    const { bundle, chartBundle } = result.current;
    expect(bundle).not.toBeNull();
    expect(chartBundle).not.toBeNull();
    expect(bundle!.candles).toBe(chartBundle!.candles); // shared ref
    expect(bundle!.segments).toBe(chartBundle!.segments); // shared ref
    expect(chartBundle!.quote_ratio.points).toEqual([]); // empty stub
    expect(chartBundle!.fill_strength.points).toEqual([]); // empty stub
    expect(bundle!.quote_ratio.points.length).toBe(1); // live overlay carries the point
  });

  it('loads hoga panes and overlay sidecars through separate lightweight range requests', () => {
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

    expect(useRangeHogaDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      { mode: 'hoga' },
    );
    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: true,
        tradeVolumePocEnabled: true,
        brokerLateEntriesEnabled: false,
        brokerLateEntryStartHHMM: null,
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
    );
  });

  it('holds sidecar requests while minute candle price range is still loading', () => {
    candlesMock.candles = [];
    candlesMock.isFetching = true;

    const { rerender } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      null,
      null,
      null,
      null,
      undefined,
      null,
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: null,
      }),
    );

    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isFetching = false;
    rerender();

    expect(useRangeSidecarDeltaSpy).toHaveBeenLastCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
    );
  });

  it('disables the sidecar range request when every sidecar indicator is off', () => {
    useLivePageStore.setState({
      askPeakEnabled: false,
      bidPeakEnabled: false,
      brokerLateEntryEnabled: false,
      programTradeEnabled: false,
      tradeVolumePocEnabled: false,
      volumeDistributionEnabled: false,
      volumeDistributionRangeCount: 12,
    });

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

    expect(useRangeHogaDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      { mode: 'hoga' },
    );
    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      null,
      null,
      null,
      null,
      undefined,
      null,
      expect.objectContaining({
        mode: 'sidecar',
        askPeaksEnabled: false,
        bidPeaksEnabled: false,
        programTradeEnabled: false,
        tradeVolumePocEnabled: false,
        brokerLateEntriesEnabled: false,
        volumeDistributionBins: null,
        tradeVolumePocBins: null,
      }),
    );
  });

  it('routes live hoga and sidecars through delta range hooks', () => {
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

    expect(useRangeHogaDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      { mode: 'hoga' },
    );
    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({ mode: 'sidecar' }),
    );
  });

  it('keeps stored range and screener daily fallbacks enabled when bypass is enabled', () => {
    const result = renderUseLiveBundle({
      timeframe: 'D',
      settings: { kis_rest_bypass_enabled: true },
      screenerDailyCandles: [{ t_ms: 1, open: 1, high: 2, low: 1, close: 2, volume: 100 }],
    });

    expect(result.bundle?.candles.length).toBeGreaterThan(0);
    expect(screenerDailyCandlesSpy).toHaveBeenLastCalledWith('005930', '20250611', '20260527');
  });

  it('uses disk range candles for minute when KIS REST bypass is enabled', () => {
    candlesMock.candles = [];
    // store sourcePref가 무엇이든 캔들 쿼리는 'hogaplay_first' 고정(아래 검증).
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });

    const result = renderUseLiveBundle({
      timeframe: '1m',
      settings: { kis_rest_bypass_enabled: true },
      rangeCandles: [
        { ts_ms: 1_779_840_000_000, open: 71_000, high: 71_300, low: 70_900, close: 71_234, vol_a: 1000, vol_b: 0 },
      ],
    });

    // 우회 ON 분봉: 디스크 캔들 쿼리(mode=candles)가 code 있음 + sourcePref 'hogaplay_first' 고정.
    const candleCall = useRangeSpy.mock.calls.find((call) => (call[6] as { mode?: string } | undefined)?.mode === 'candles');
    expect(candleCall?.[0]).toBe('005930');
    expect(candleCall?.[7]).toBe('hogaplay_first');
    // KIS 분봉 쿼리는 우회 ON이면 code=null로 비활성.
    expect(livePastCandlesSpy).toHaveBeenLastCalledWith(null, null, null, 'KRX', '20260527');
    expect(result.chartBundle?.candles).toHaveLength(1);
  });

  it('returns disk candles before sidecar data arrives (bypass ON)', () => {
    candlesMock.candles = [];

    useRangeSpy.mockImplementation((...args: unknown[]) => {
      const options = args[6] as { mode?: string } | undefined;
      if (options?.mode === 'candles') {
        return rangeResult({
          ...fallbackRangeBundle(71_234),
          candles: [
            { ts_ms: 1_779_840_000_000, open: 71_000, high: 71_300, low: 70_900, close: 71_234, vol_a: 1000, vol_b: 0 },
          ],
        });
      }
      return rangeResult();
    });
    useRangeHogaDeltaSpy.mockReturnValue(rangeResult(fallbackRangeBundle(71_234)));
    useRangeSidecarDeltaSpy.mockImplementation(() => ({
      data: null,
      isLoading: true,
      error: null,
      isPlaceholderData: false,
      isFetching: true,
    }));

    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
    );

    expect(result.current.chartBundle?.candles).toHaveLength(1);
    expect(result.current.chartBundle?.trade_volume_pocs).toEqual([]);
    expect(result.current.chartBundle?.volume_distributions).toEqual([]);
  });

  it('suppresses bypass-time candle warnings but still notifies for non-bypass transport failures', async () => {
    const realNotifyFailure = useKisRestModeStore.getState().notifyFailure;
    const notifyFailureSpy = vi.fn((nowMs?: number) => realNotifyFailure(nowMs));
    useKisRestModeStore.setState({
      lastFailureAtMs: null,
      lastToastAtMs: null,
      notifyFailure: notifyFailureSpy,
    });
    candlesMock.warnings = [{ reason: 'kis_api_error', msg: 'TRANSPORT/ConnectError' }];

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), {
      wrapper: createWrapper({ kis_rest_bypass_enabled: true }),
    });

    expect(notifyFailureSpy).not.toHaveBeenCalled();
    expect(useKisRestModeStore.getState().lastFailureAtMs).toBeNull();
    expect(useKisRestModeStore.getState().lastToastAtMs).toBeNull();

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(notifyFailureSpy).toHaveBeenCalledTimes(1);
      expect(useKisRestModeStore.getState().lastFailureAtMs).not.toBeNull();
      expect(useKisRestModeStore.getState().lastToastAtMs).not.toBeNull();
    });
  });

  it('passes the KIS candle price range to the volume-distribution sidecar', () => {
    candlesMock.candles = [
      { t_ms: 1779840000000, open: 70000, high: 70200, low: 69900, close: 70050, volume: 1000 },
      { t_ms: 1779840060000, open: 70050, high: 70350, low: 70020, close: 70300, volume: 1500 },
    ];

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70350 },
      }),
    );
  });

  it('merges sidecar broker late entries into the hoga pane bundle', () => {
    useLivePageStore.setState({ brokerLateEntryEnabled: true });
    const sidecarBundle = {
      code: '005930',
      from_date: '20260520',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [{ t_ms: 1_779_840_000_000, broker: 'NH투자증권', side: 'buy', net: 42 }],
      price_level_hits: [],
      trade_volume_pocs: [],
      program_trade: { points: [] },
    };
    useRangeSidecarDeltaSpy.mockReturnValueOnce(rangeResult(sidecarBundle));

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(result.current.hogaBundle?.broker_late_entries).toEqual(sidecarBundle.broker_late_entries);
  });

  it('merges sidecar volume distributions into the live bundle', () => {
    const distribution = {
      date: '20260527',
      range_count: 1,
      price_min: 69900,
      price_max: 70100,
      session_open_ms: 1_779_840_000_000,
      session_close_ms: 1_779_863_400_000,
      bins: [{ price_low: 69900, price_high: 70100, qty: 123 }],
    };
    const sidecarBundle = {
      code: '005930',
      from_date: '20260520',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [distribution],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [],
      price_level_hits: [],
      trade_volume_pocs: [],
      program_trade: { points: [] },
    };
    useRangeSidecarDeltaSpy.mockReturnValueOnce(rangeResult(sidecarBundle));

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(result.current.bundle?.volume_distributions).toEqual([distribution]);
    expect(result.current.chartBundle?.volume_distributions).toEqual([distribution]);
  });

  it('merges sidecar depth heatmap into the chart and live bundles', () => {
    const depthPoint = {
      t_ms: 1_779_840_060_000,
      asks: [[70_100, 500], [70_200, 300]],
      bids: [[70_000, 400], [69_900, 200]],
    };
    const sidecarBundle = {
      code: '005930',
      from_date: '20260520',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [],
      price_level_hits: [],
      trade_volume_pocs: [],
      depth_heatmap: [depthPoint],
      program_trade: { points: [] },
    };
    useRangeSidecarDeltaSpy.mockReturnValueOnce(rangeResult(sidecarBundle));

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    // Regression: the sidecar-only depth_heatmap must be threaded onto the built
    // chart bundle (and the live bundle spread from it), else the overlay's
    // pointCount stays 0 and no cells render even though the fetch succeeded.
    expect(result.current.chartBundle?.depth_heatmap).toEqual([depthPoint]);
    expect(result.current.bundle?.depth_heatmap).toEqual([depthPoint]);
  });

  it('overlays today live-ratcheted depth buckets on top of the sidecar past (today wins by t_ms)', () => {
    // Sidecar carries a past-only bucket (100) AND a bucket at today's live
    // t_ms (1779840060000) that the live ratchet must override.
    const pastOnly = { t_ms: 100, asks: [[70_100, 500]], bids: [[70_000, 400]] };
    const overlapStale = { t_ms: 1_779_840_060_000, asks: [[70_100, 999]], bids: [[70_000, 999]] };
    const sidecarBundle = {
      code: '005930',
      from_date: '20260520',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [],
      price_level_hits: [],
      trade_volume_pocs: [],
      depth_heatmap: [pastOnly, overlapStale],
      program_trade: { points: [] },
    };
    useRangeSidecarDeltaSpy.mockReturnValueOnce(rangeResult(sidecarBundle));

    // Drive a continuous-book live ob tick (asks/bids with depth beyond L3) so
    // the incremental builder produces a depth_heatmap_today bucket at the
    // minute-aligned t_ms 1779840060000.
    const liveWithDepth: LiveSeriesData = {
      ...liveFixture,
      ob: [
        {
          t_ms: 1_779_840_060_000,
          total_ask_qty: 800,
          total_bid_qty: 700,
          kind: 'ob',
          asks: [
            { price: 70_100, qty: 500 },
            { price: 70_200, qty: 100 },
            { price: 70_300, qty: 100 },
            { price: 70_400, qty: 100 },
          ],
          bids: [
            { price: 70_000, qty: 400 },
            { price: 69_900, qty: 100 },
            { price: 69_800, qty: 100 },
            { price: 69_700, qty: 100 },
          ],
        },
      ],
    };

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveWithDepth), { wrapper });

    const merged = result.current.bundle?.depth_heatmap ?? [];
    expect(merged.map((p) => p.t_ms)).toEqual([100, 1_779_840_060_000]);
    // past-only bucket survives untouched
    expect(merged[0]).toEqual(pastOnly);
    // today's live bucket wins over the stale sidecar bucket at the same t_ms
    expect(merged[1].asks).toEqual([
      [70_100, 500],
      [70_200, 100],
      [70_300, 100],
      [70_400, 100],
    ]);
    expect(merged[1].asks_max).toEqual([
      [70_100, 500],
      [70_200, 100],
      [70_300, 100],
      [70_400, 100],
    ]);
  });

  it('merges sidecar program trade into the chart and live bundles', () => {
    const programPoint = {
      t: 1_779_840_060_000,
      net_qty: 1000,
      net_amount: 70_000_000,
      delta_qty: 1000,
      delta_amount: 70_000_000,
      gap_risk: false,
    };
    const sidecarBundle = {
      code: '005930',
      from_date: '20260520',
      to_date: '20260527',
      bucket_ms: 60000,
      segments: [],
      candles: [],
      quote_ratio: { bucket_ms: 60000, points: [] },
      fill_strength: { bucket_ms: 60000, points: [] },
      volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
      volume_profile_by_day: [],
      volume_distributions: [],
      investorPoints: [],
      ask_peaks: [],
      bid_peaks: [],
      broker_late_entries: [],
      price_level_hits: [],
      trade_volume_pocs: [],
      program_trade: { points: [programPoint], source: 'kis_program_trade' as const },
    };
    useRangeSidecarDeltaSpy.mockReturnValueOnce(rangeResult(sidecarBundle));

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(result.current.chartBundle?.program_trade?.points).toEqual([programPoint]);
    expect(result.current.bundle?.program_trade?.points).toEqual([programPoint]);
  });

  it('clamps pastFrom to 249 days before today when historicalFromDate is older', () => {
    useLivePageStore.setState({ historicalFromDate: '20250101' });
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    // 5th arg = todayKst (=== minutePastTo === today), gating chunk freshness:
    // the today head chunk polls; past-only walk-back chunks freeze.
    expect(livePastCandlesSpy).toHaveBeenCalledWith('005930', '20250920', '20260527', 'KRX', '20260527');
    // 5th arg = priceRange (undefined here); 6th = todayKst, which drives the
    // 5-min refetch that advances pastMaxQrT (review C1). minutePastTo === today
    // so todayKst === to === '20260527'.
    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20250920',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
    );
  });

  it('requests POC bins without volume distributions when only trade POC is enabled', () => {
    useLivePageStore.setState({
      historicalFromDate: '20260501',
      volumeDistributionEnabled: false,
      tradeVolumePocEnabled: true,
      volumeDistributionRangeCount: 12,
    });

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260501',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: null,
        tradeVolumePocBins: 12,
        volumeDistributionPriceRange: null,
      }),
    );
  });

  it('omits both optional distribution requests when both indicators are disabled', () => {
    useLivePageStore.setState({
      historicalFromDate: '20260501',
      volumeDistributionEnabled: false,
      tradeVolumePocEnabled: false,
      volumeDistributionRangeCount: 12,
    });

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(useRangeSidecarDeltaSpy).toHaveBeenCalledWith(
      '005930',
      '20260501',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        volumeDistributionBins: null,
        tradeVolumePocBins: null,
        volumeDistributionPriceRange: null,
      }),
    );
  });

  it('exposes clampEngaged=true when historicalFromDate older than 250 days', () => {
    useLivePageStore.setState({ historicalFromDate: '20250101' });
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.clampEngaged).toBe(true);
  });

  it('maps KIS bar shape to wire Candle shape (vol_a = volume, vol_b = 0)', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    const c = result.current.bundle!.candles[0];
    expect(c).toMatchObject({ ts_ms: 1779840000000, open: 70000, vol_a: 1000, vol_b: 0 });
    expect(c).not.toHaveProperty('t_ms');
    expect(c).not.toHaveProperty('volume');
  });

  it('updates the current minute candle from live trade ticks', () => {
    const liveWithTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779840030000,
          kind: 'trade',
          trades: [{ t_ms: 1779840030000, price: 70150, qty: 7, side: 1 }],
        },
      ],
    };

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveWithTrade), { wrapper });

    expect(result.current.chartBundle!.candles).toHaveLength(1);
    expect(result.current.chartBundle!.candles[0]).toMatchObject({
      ts_ms: 1779840000000,
      open: 70000,
      high: 70150,
      low: 69900,
      close: 70150,
      vol_a: 1007,
      vol_b: 0,
    });
  });

  it('does not fall back to disk on KIS minute warnings when bypass is OFF (empty gaps + toast)', () => {
    const yesterdayOpen = 1779753600000;
    candlesMock.candles = [
      { t_ms: yesterdayOpen, open: 69000, high: 69100, low: 68900, close: 69050, volume: 900 },
    ];
    candlesMock.warnings = [{ date: '20260527', reason: 'kis_api_error', msg: 'TRANSPORT/ConnectError' }];

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    // 우회 OFF: 디스크 캔들 쿼리는 code=null(미발사) — KIS 경고여도 폴백 없음.
    const candleCall = useRangeSpy.mock.calls.find(
      (call) => (call[6] as { mode?: string } | undefined)?.mode === 'candles',
    );
    expect(candleCall?.[0]).toBeNull();
    // 캔들은 KIS 응답 그대로(전일 1봉), hogaplay 보충 없음.
    expect(result.current.chartBundle!.candles).toEqual([
      { ts_ms: yesterdayOpen, open: 69000, high: 69100, low: 68900, close: 69050, vol_a: 900, vol_b: 0 },
    ]);
    // unavailable 패턴 경고 → 토스트 트리거(사용자가 우회 ON 유도).
    expect(useKisRestModeStore.getState().lastFailureAtMs).not.toBeNull();
  });

  it('shows empty candles when the KIS minute response is empty and bypass is OFF (no disk fallback)', () => {
    candlesMock.candles = [];
    candlesMock.warnings = [];

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    const candleCall = useRangeSpy.mock.calls.find(
      (call) => (call[6] as { mode?: string } | undefined)?.mode === 'candles',
    );
    expect(candleCall?.[0]).toBeNull();
    expect(result.current.chartBundle!.candles).toEqual([]);
  });

  it('does not overlay KRX live trade ticks onto an NXT candle view', () => {
    const liveWithTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779840030000,
          kind: 'trade',
          trades: [{ t_ms: 1779840030000, price: 70150, qty: 7, side: 1 }],
        },
      ],
    };

    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveWithTrade, { venue: 'NXT' }),
      { wrapper },
    );

    expect(result.current.chartBundle!.candles).toHaveLength(1);
    expect(result.current.chartBundle!.candles[0]).toMatchObject({
      ts_ms: 1779840000000,
      high: 70100,
      close: 70050,
      vol_a: 1000,
    });
  });

  it('appends a new forming candle when live trade ticks move into the next bucket', () => {
    const liveWithTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779840060000,
          kind: 'trade',
          trades: [{ t_ms: 1779840060000, price: 70200, qty: 3, side: 1 }],
        },
      ],
    };

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveWithTrade), { wrapper });

    expect(result.current.chartBundle!.candles).toHaveLength(2);
    expect(result.current.chartBundle!.candles[1]).toMatchObject({
      ts_ms: 1779840060000,
      open: 70050,
      high: 70200,
      low: 70200,
      close: 70200,
      vol_a: 3,
      vol_b: 0,
    });
  });

  it('ignores live trade ticks for older buckets', () => {
    const liveWithOldTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779839940000,
          kind: 'trade',
          trades: [{ t_ms: 1779839940000, price: 80000, qty: 99, side: 1 }],
        },
      ],
    };

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveWithOldTrade), { wrapper });

    expect(result.current.chartBundle!.candles).toEqual([
      { ts_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, vol_a: 1000, vol_b: 0 },
    ]);
  });

  it('keeps the chart bundle stable when live trade ticks are outside the candle overlay window', () => {
    const stablePastCandlesResult = {
      data: {
        code: '005930',
        from: '',
        to: '',
        candles: candlesMock.candles,
        cached_dates: [],
        fresh_dates: [],
        data_warnings: candlesMock.warnings,
        effective_sessions: candlesMock.effectiveSessions,
      },
      isLoading: false,
      error: null,
      isPlaceholderData: candlesMock.isPlaceholderData,
      isFetching: candlesMock.isFetching,
    };
    livePastCandlesSpy.mockReturnValue(stablePastCandlesResult);

    const { result, rerender } = renderHook(
      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
      { wrapper, initialProps: { live: liveFixture } },
    );
    const before = result.current.chartBundle;

    const liveWithOldTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779839940000,
          kind: 'trade',
          trades: [{ t_ms: 1779839940000, price: 80000, qty: 99, side: 1 }],
        },
      ],
    };
    rerender({ live: liveWithOldTrade });

    expect(result.current.chartBundle).toBe(before);
  });

  it('feeds synthesized live candle volume into the existing volume projector', () => {
    const liveWithTrade: LiveSeriesData = {
      ...liveFixture,
      trade: [
        {
          t_ms: 1779840030000,
          kind: 'trade',
          trades: [{ t_ms: 1779840030000, price: 70150, qty: 7, side: 1 }],
        },
      ],
    };
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveWithTrade), { wrapper });
    const axis = createVirtualAxis([
      {
        date: '20260527',
        sessionOpenMs: 1779840000000,
        sessionCloseMs: 1779863400000,
      },
    ]);

    const volume = projectVolume(result.current.chartBundle!, axis);

    expect(volume).toHaveLength(1);
    expect(volume[0].value).toBe(1007);
  });

  // (c) /diagnose 2026-06-09 후속: 백엔드가 내려준 past-candles 경고를 결과로 노출
  // (이전엔 페치만 하고 버려서 화면에 rate-limit 지연을 못 알렸음).
  it('무경고면 pastDataWarnings는 빈 배열', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.pastDataWarnings).toEqual([]);
  });
  it('분봉: past-candles 경고를 pastDataWarnings로 노출', () => {
    candlesMock.warnings = [{ date: '20260609', reason: 'kis_rate_limit', msg: 'rate limit' }];
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.pastDataWarnings).toEqual([
      { date: '20260609', reason: 'kis_rate_limit', msg: 'rate limit' },
    ]);
  });
  it('D/W/M: past-candles(분봉) 경고가 아닌 past-daily 경고를 노출', () => {
    // 분봉 경로 경고가 세팅돼 있어도 D에선 daily 경로 경고(여기선 빈 배열)를 본다.
    candlesMock.warnings = [{ date: '20260609', reason: 'kis_rate_limit', msg: 'minute path' }];
    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527', liveFixture), { wrapper });
    expect(result.current.pastDataWarnings).toEqual([]); // daily spy의 data_warnings=[]
  });

});

describe('useLiveBundle daily/minute branching (ADR-0048)', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
    screenerDailyCandlesSpy.mockClear();
    useRangeSpy.mockClear();
    useRangeHogaDeltaSpy.mockClear();
    useRangeSidecarDeltaSpy.mockClear();
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
    screenerDailyCandlesMock.candles = [];
    rangeMock.isPlaceholderData = false;
    rangeMock.isFetching = false;
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
  });

  it('D timeframe calls daily hook with non-null code, minute hook with null code', () => {
    renderHook(() => useLiveBundle('005930', 'D', '20260527', liveFixture), { wrapper });
    const lastDailyCall = livePastDailyCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastDailyCall[0]).toBe('005930');
    expect(lastDailyCall[3]).toBe('KRX');
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastMinuteCall[0]).toBeNull();
  });

  it('D timeframe disables investor query when investor panes are hidden', () => {
    renderHook(() => useLiveBundle('005930', 'D', '20260527', liveFixture), { wrapper });
    const lastInvestorCall = livePastInvestorNetSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastInvestorCall[0]).toBeNull();
  });

  it('D timeframe enables investor query and holds reveal loading when investor panes are visible', () => {
    investorMock.isLoading = true;
    const { result } = renderHook(
      () => useLiveBundle('005930', 'D', '20260527', liveFixture, { investorNetEnabled: true }),
      { wrapper },
    );
    const lastInvestorCall = livePastInvestorNetSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastInvestorCall[0]).toBe('005930');
    expect(result.current.isPastCandlesLoading).toBe(true);
  });

  it('D timeframe shows empty candles when daily KIS is empty and bypass is OFF (no screener/disk fallback)', () => {
    dailyCandlesMock.candles = [];
    dailyCandlesMock.warnings = [{ reason: 'kis_transport', msg: 'TRANSPORT/ConnectError' }];

    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527', liveFixture), { wrapper });

    // 우회 OFF D: 스크리너는 code=null(미발사), 디스크 캔들 쿼리도 code=null. 폴백 없음.
    expect(screenerDailyCandlesSpy).toHaveBeenLastCalledWith(null, null, null);
    const candleCall = useRangeSpy.mock.calls.find(
      (call) => (call[6] as { mode?: string } | undefined)?.mode === 'candles',
    );
    expect(candleCall?.[0]).toBeNull();
    expect(result.current.chartBundle!.candles).toEqual([]);
  });

  it('D timeframe uses screener daily candles when bypass is ON (disk-only)', () => {
    dailyCandlesMock.candles = [
      { t_ms: 1779840000000, open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ];
    screenerDailyCandlesMock.candles = [
      { t_ms: 1779753600000, open: 69000, high: 69100, low: 68900, close: 69050, volume: 900 },
      { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ];

    const { result } = renderHook(
      () => useLiveBundle('005930', 'D', '20260527', liveFixture),
      { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
    );

    // 우회 ON: KIS 일봉은 code=null(미발사), 스크리너만 사용.
    expect(livePastDailyCandlesSpy).toHaveBeenLastCalledWith(null, null, null, 'KRX');
    expect(screenerDailyCandlesSpy).toHaveBeenCalledWith('005930', '20250611', '20260527');
    expect(result.current.chartBundle!.candles).toEqual([
      { ts_ms: 1779753600000, open: 69000, high: 69100, low: 68900, close: 69050, vol_a: 900, vol_b: 0 },
      { ts_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, vol_a: 1000, vol_b: 0 },
    ]);
    expect(result.current.chartBundle!.segments.map((s) => s.source)).toEqual(['screener_daily', 'screener_daily']);
  });

  it('W/M timeframes have no hogaplay 1m aggregation path when daily KIS returns no candles', () => {
    dailyCandlesMock.candles = [];
    dailyCandlesMock.warnings = [{ reason: 'kis_transport', msg: 'TRANSPORT/ConnectError' }];

    const { result: week } = renderHook(() => useLiveBundle('005930', 'W', '20260527', liveFixture), { wrapper });
    expect(week.current.chartBundle!.candles).toEqual([]);
    expect(useRangeSpy).not.toHaveBeenCalledWith(
      '005930',
      expect.anything(),
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({ mode: 'candles', brokerLateEntriesEnabled: false }),
    );

    useRangeSpy.mockClear();
    const { result: month } = renderHook(() => useLiveBundle('005930', 'M', '20260527', liveFixture), { wrapper });
    expect(month.current.chartBundle!.candles).toEqual([]);
    expect(useRangeSpy).not.toHaveBeenCalledWith(
      '005930',
      expect.anything(),
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({ mode: 'candles', brokerLateEntriesEnabled: false }),
    );
  });

  it('1m timeframe calls minute hook with non-null code, daily hook with null code', () => {
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastMinuteCall[0]).toBe('005930');
    expect(lastMinuteCall[3]).toBe('KRX');
    const lastDailyCall = livePastDailyCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastDailyCall[0]).toBeNull();
  });

  it('NXT minute venue expands chart session bounds to 08:00~20:00 KST and threads the query venue', () => {
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture, { venue: 'NXT' }),
      { wrapper },
    );
    const seg = result.current.chartBundle!.segments[0];
    expect(seg.session_open_ms).toBe(1779836400000);
    expect(seg.session_close_ms).toBe(1779879600000);
    const lastMinuteCall = livePastCandlesSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(lastMinuteCall[3]).toBe('NXT');
  });

  it('NXT minute venue narrows fallback dates to KRX effective sessions', () => {
    candlesMock.effectiveSessions = [
      {
        date: '20260527',
        venue: 'KRX',
        open_ms: 1779840000000,
        close_ms: 1779863400000,
      },
    ];

    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture, { venue: 'NXT' }),
      { wrapper },
    );

    const seg = result.current.chartBundle!.segments[0];
    expect(seg.session_open_ms).toBe(1779840000000);
    expect(seg.session_close_ms).toBe(1779863400000);
  });

  it('clampEngaged is false on D when historicalFromDate is very old', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(() => useLiveBundle('005930', 'D', '20260527', liveFixture), { wrapper });
    expect(result.current.clampEngaged).toBe(false);
  });

  it('clampEngaged is true on 1m when historicalFromDate is older than 250d', () => {
    useLivePageStore.setState({ historicalFromDate: '20100101' });
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.clampEngaged).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Historical-extension atomization gate (/diagnose 2026-05-31)
//
// A leftward pan re-keys BOTH past queries; they settle in separate commits, so
// useLiveBundle holds the last fully-settled bundle until both are fresh and the
// prepend lands in ONE commit (otherwise LiveChartRoot's viewport shift sees a
// candles-only union and flickers across two paints). The hold is scoped to a
// genuine extension via historicalFromDate != null, so code/timeframe switches
// (which also re-key the queries but reset historicalFromDate) are NOT gated.
//
// Observed via bundle IDENTITY: while held, an SSE-driven `live` change is
// masked (bundle stays the prior object); when released the fresh computedBundle
// (a new object) is returned.
describe('useLiveBundle extension atomization gate', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    useRangeSpy.mockClear();
    useRangeHogaDeltaSpy.mockClear();
    useRangeSidecarDeltaSpy.mockClear();
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
	    candlesMock.isFetching = false;
	    candlesMock.warnings = [];
	    rangeMock.isPlaceholderData = false;
	    rangeMock.isFetching = false;
	    rangeMock.isHistoricalDeltaFetching = false;
	    useLivePageStore.setState({ activeCode: '005930', candleTimeframe: '1m', historicalFromDate: null });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
  });

  const liveWithOb = (tMs: number): LiveSeriesData => ({
    ...liveFixture,
    ob: [{ t_ms: tMs, total_ask_qty: 100, total_bid_qty: 80, kind: 'ob' }],
  });

	  it('HOLDS the last-settled chartBundle while a re-keyed past query is placeholder+fetching', () => {
    // Post bundle-split (2026-06-09): the gate holds the CHART side (candle/
    // segment prepend atomicity drives the viewport). The full `bundle` reflects
    // the live hoga overlay even mid-extension, so assert on `chartBundle` —
    // that is what the gate freezes for the one-commit prepend.
    useLivePageStore.setState({ historicalFromDate: '20260420' }); // genuine extension
    const { result, rerender } = renderHook(
      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
      { wrapper, initialProps: { live: liveWithOb(1779840060000) } },
    );
    const settled = result.current.chartBundle; // both fresh → computedChartBundle, now last-settled
    expect(settled).not.toBeNull();

    // Mid-extension: hoga still placeholder+fetching AND a re-keyed candle query
    // would rebuild computedChartBundle — the gate must mask it and keep the prior object.
	    rangeMock.isPlaceholderData = true;
	    rangeMock.isFetching = true;
	    rangeMock.isHistoricalDeltaFetching = true;
	    candlesMock.candles = [
      { t_ms: 1779753600000, open: 69000, high: 69100, low: 68900, close: 69050, volume: 900 },
      DEFAULT_CANDLE,
    ];
    rerender({ live: liveWithOb(1779840120000) });
    expect(result.current.chartBundle).toBe(settled); // HELD
    expect(result.current.chartBundle!.candles).toHaveLength(1);

    // Both fresh again → released to the fresh computedChartBundle with the prepend.
	    rangeMock.isPlaceholderData = false;
	    rangeMock.isFetching = false;
	    rangeMock.isHistoricalDeltaFetching = false;
	    rerender({ live: liveWithOb(1779840120000) });
	    expect(result.current.chartBundle).not.toBe(settled); // RELEASED
	    expect(result.current.chartBundle!.candles).toHaveLength(2);
	  });

	  it('HOLDS the last-settled chartBundle while sidecar delta is still fetching', () => {
	    useLivePageStore.setState({ historicalFromDate: '20260420' });
	    const sidecarState = {
	      isPlaceholderData: false,
	      isFetching: false,
	      isHistoricalDeltaFetching: false,
	    };
	    useRangeSidecarDeltaSpy.mockImplementation(() => ({
	      data: null,
	      isLoading: false,
	      error: null,
	      ...sidecarState,
	    }));
	    const { result, rerender } = renderHook(
	      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
	      { wrapper, initialProps: { live: liveWithOb(1779840060000) } },
	    );
	    const settled = result.current.chartBundle;
	    expect(settled).not.toBeNull();

	    sidecarState.isPlaceholderData = true;
	    sidecarState.isFetching = true;
	    sidecarState.isHistoricalDeltaFetching = true;
	    candlesMock.candles = [
	      { t_ms: 1779753600000, open: 69000, high: 69100, low: 68900, close: 69050, volume: 900 },
	      DEFAULT_CANDLE,
	    ];
	    rerender({ live: liveWithOb(1779840120000) });

	    expect(result.current.chartBundle).toBe(settled);
	    expect(result.current.chartBundle!.candles).toHaveLength(1);
	  });

	  it('does NOT gate a same-key periodic refetch (isFetching true but not placeholder)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260420' });
    const { result, rerender } = renderHook(
      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
      { wrapper, initialProps: { live: liveWithOb(1779840060000) } },
    );
    const before = result.current.bundle;
    // Background refetch on the SAME key: fetching but data is real, not placeholder.
    candlesMock.isFetching = true;
    rerender({ live: liveWithOb(1779840120000) });
    expect(result.current.bundle).not.toBe(before); // live tick flows through
	  });

	  it('does NOT gate a post-merge today refresh from the range delta hook', () => {
	    useLivePageStore.setState({ historicalFromDate: '20260420' });
	    const { result, rerender } = renderHook(
	      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
	      { wrapper, initialProps: { live: liveWithOb(1779840060000) } },
	    );
	    const settled = result.current.chartBundle;
	    expect(settled).not.toBeNull();

	    rangeMock.isPlaceholderData = true;
	    rangeMock.isFetching = true;
	    rangeMock.isHistoricalDeltaFetching = false;
	    candlesMock.candles = [
	      { t_ms: 1779753600000, open: 69000, high: 69100, low: 68900, close: 69050, volume: 900 },
	      DEFAULT_CANDLE,
	    ];
	    rerender({ live: liveWithOb(1779840120000) });

	    expect(result.current.chartBundle).not.toBe(settled);
	    expect(result.current.chartBundle!.candles).toHaveLength(2);
	  });

  it('does NOT gate when historicalFromDate is null (code / timeframe switch)', () => {
    // A timeframe switch re-keys the past queries (placeholder+fetching) but
    // setCandleTimeframe resets historicalFromDate to null, so the gate must NOT
    // hold the previous timeframe's bundle.
    useLivePageStore.setState({ historicalFromDate: null });
    const { result, rerender } = renderHook(
      ({ live }) => useLiveBundle('005930', '1m', '20260527', live),
      { wrapper, initialProps: { live: liveWithOb(1779840060000) } },
    );
    const before = result.current.bundle;
    candlesMock.isPlaceholderData = true;
    candlesMock.isFetching = true;
    rerender({ live: liveWithOb(1779840120000) });
    expect(result.current.bundle).not.toBe(before); // NOT gated (no extension in progress)
  });
});

describe('useLiveBundle isExtending', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
    useRangeSpy.mockClear();
    useRangeHogaDeltaSpy.mockClear();
    useRangeSidecarDeltaSpy.mockClear();
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
	    rangeMock.isPlaceholderData = false;
	    rangeMock.isFetching = false;
	    rangeMock.isHistoricalDeltaFetching = false;
    useLivePageStore.setState({
      activeCode: '005930',
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
  });

  it('is true during a historical extension (placeholderData + isFetching, historicalFromDate set)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260514' });
    candlesMock.isPlaceholderData = true;
    candlesMock.isFetching = true;
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper },
    );
    expect(result.current.isExtending).toBe(true);
  });

  it('is false when not extending (no historicalFromDate)', () => {
    useLivePageStore.setState({ historicalFromDate: null });
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper },
    );
    expect(result.current.isExtending).toBe(false);
  });

  // 우회 ON 좌측 팬: 차트 캔들이 KIS가 아니라 디스크 쿼리(minuteDiskCandles, plain useRange
  // mode=candles)에서 온다. 이 쿼리가 re-key로 이전 데이터를 placeholder로 보이며 더 오래된
  // 창을 fetch 중이면 게이트가 홀드해야 프리펜드가 원자적이다.
  // 선행 테스트의 delta 스파이 구현 누수에 견고하도록 hoga/sidecar delta는 false로 고정한다.
  const idleDeltaSpy = () => ({
    data: null,
    isLoading: false,
    error: null,
    isPlaceholderData: false,
    isFetching: false,
    isHistoricalDeltaFetching: false,
  });

  it('is true when the disk candle query is doing its historical delta fetch (bypass ON)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260514' });
    useRangeHogaDeltaSpy.mockImplementation(idleDeltaSpy);
    useRangeSidecarDeltaSpy.mockImplementation(idleDeltaSpy);
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    // 디스크 캔들 쿼리가 좌측 팬 re-key로 placeholder를 보이며 더 오래된 창을 fetch 중.
    useRangeSpy.mockImplementation((...args: unknown[]) => {
      const options = args[6] as { mode?: string } | undefined;
      const isCandles = options?.mode === 'candles';
      return {
        data: isCandles
          ? { ...fallbackRangeBundle(), candles: [{ ts_ms: 1_779_753_600_000, open: 69_000, high: 69_100, low: 68_900, close: 69_050, vol_a: 900, vol_b: 0 }] }
          : null,
        isLoading: false,
        error: null,
        isPlaceholderData: isCandles,
        isFetching: isCandles,
      };
    });
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
    );
    expect(result.current.isExtending).toBe(true);
  });

  // 과잉 홀드 방지: 디스크 쿼리가 활성이어도 fetch 중이 아니면(정착) 홀드 안 함.
  it('is false when the disk candle query is active but idle (settled, not fetching)', () => {
    useLivePageStore.setState({ historicalFromDate: '20260514' });
    useRangeHogaDeltaSpy.mockImplementation(idleDeltaSpy);
    useRangeSidecarDeltaSpy.mockImplementation(idleDeltaSpy);
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    useRangeSpy.mockImplementation((...args: unknown[]) => {
      const options = args[6] as { mode?: string } | undefined;
      const isCandles = options?.mode === 'candles';
      return {
        data: isCandles
          ? { ...fallbackRangeBundle(), candles: [{ ts_ms: 1_779_753_600_000, open: 69_000, high: 69_100, low: 68_900, close: 69_050, vol_a: 900, vol_b: 0 }] }
          : null,
        isLoading: false,
        error: null,
        isPlaceholderData: false,
        isFetching: false,
      };
    });
    const { result } = renderHook(
      () => useLiveBundle('005930', '1m', '20260527', liveFixture),
      { wrapper: createWrapper({ kis_rest_bypass_enabled: true }) },
    );
    expect(result.current.isExtending).toBe(false);
  });
});
