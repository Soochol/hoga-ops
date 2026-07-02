import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { planLiveRangeRequest, useLiveBundle } from './useLiveBundle';
import { useLivePageStore } from '../state/livePage';
import { useSourcePreferenceStore } from '../state/sourcePreference';
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
  warnings: [] as Array<{ date?: string; reason: string; msg: string }>,
};
const livePastDailyCandlesSpy = vi.fn(() => ({
  data: {
    code: '005930',
    from: '',
    to: '',
    candles: [
      { t_ms: 1779840000000, open: 70000, high: 70100, low: 69900, close: 70050, volume: 1000 },
    ],
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

const rangeMock = { isPlaceholderData: false, isFetching: false };
const useRangeSpy = vi.fn<(...args: unknown[]) => any>(() => ({
  data: null,
  isLoading: false,
  error: null,
  isPlaceholderData: rangeMock.isPlaceholderData,
  isFetching: rangeMock.isFetching,
}));
vi.mock('../api/range', () => ({
  useRange: (...args: unknown[]) => useRangeSpy(...args as []),
}));

const wrapper = ({ children }: { children: ReactNode }) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
};

describe('planLiveRangeRequest', () => {
  it('plans the minute /api/range request with indicator-controlled optional slices', () => {
    expect(planLiveRangeRequest({
      code: '005930',
      timeframe: '1m',
      todayKstYyyymmdd: '20260527',
      historicalFromDate: '20260501',
      tradeVolumePocEnabled: true,
      brokerLateEntryEnabled: true,
      brokerLateEntryStartHHMM: 945,
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
        brokerLateEntriesEnabled: true,
        brokerLateEntryStartHHMM: 945,
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
      tradeVolumePocEnabled: false,
      brokerLateEntryEnabled: false,
      brokerLateEntryStartHHMM: 945,
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
        brokerLateEntriesEnabled: false,
        brokerLateEntryStartHHMM: null,
        volumeDistributionBins: null,
        tradeVolumePocBins: null,
        volumeDistributionPriceRange: null,
      },
    });
  });
});

describe('useLiveBundle', () => {
  beforeEach(() => {
    livePastCandlesSpy.mockClear();
    livePastDailyCandlesSpy.mockClear();
    livePastInvestorNetSpy.mockClear();
    useRangeSpy.mockClear();
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
    candlesMock.effectiveSessions = [];
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
    });
    useSourcePreferenceStore.setState({ sourcePreference: 'kis_ws_first' });
  });

  it('builds a today-only bundle when historicalFromDate is null', () => {
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.bundle!.segments.length).toBe(1);
    expect(result.current.bundle!.segments[0].source).toBe('kis_live');
    expect(result.current.bundle!.candles.length).toBe(1);
    expect(result.current.bundle!.quote_ratio.points.length).toBe(1);
  });

  it('returns null bundle when code is null', () => {
    const { result } = renderHook(() => useLiveBundle(null, '1m', '20260527', liveFixture), { wrapper });
    expect(result.current.bundle).toBeNull();
    expect(result.current.chartBundle).toBeNull();
  });

  it('splits the candle side (chartBundle) from the live hoga overlay (bundle)', () => {
    // Bundle-split (2026-06-09, Phase A): candle/volume/axis read `chartBundle`
    // (no ob/trade deps → stable across SSE ticks); hoga panes read the full
    // `bundle`. Both share candles + segments refs so the VirtualAxis stays
    // single-build; chartBundle carries only an empty hoga stub.
    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
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
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(useRangeSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      { mode: 'hoga' },
    );
    expect(useRangeSpy).toHaveBeenCalledWith(
      '005930',
      '20260520',
      '20260527',
      '1m',
      undefined,
      '20260527',
      expect.objectContaining({
        mode: 'sidecar',
        brokerLateEntriesEnabled: false,
        brokerLateEntryStartHHMM: null,
        volumeDistributionBins: 10,
        tradeVolumePocBins: 10,
        volumeDistributionPriceRange: { min: 69900, max: 70100 },
      }),
    );
  });

  it('passes the KIS candle price range to the volume-distribution sidecar', () => {
    candlesMock.candles = [
      { t_ms: 1779840000000, open: 70000, high: 70200, low: 69900, close: 70050, volume: 1000 },
      { t_ms: 1779840060000, open: 70050, high: 70350, low: 70020, close: 70300, volume: 1500 },
    ];

    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(useRangeSpy).toHaveBeenCalledWith(
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
    useRangeSpy
      .mockReturnValueOnce({ data: null, isLoading: false, error: null, isPlaceholderData: false, isFetching: false })
      .mockReturnValueOnce({ data: sidecarBundle, isLoading: false, error: null, isPlaceholderData: false, isFetching: false });

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
    useRangeSpy
      .mockReturnValueOnce({ data: null, isLoading: false, error: null, isPlaceholderData: false, isFetching: false })
      .mockReturnValueOnce({ data: sidecarBundle, isLoading: false, error: null, isPlaceholderData: false, isFetching: false });

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(result.current.bundle?.volume_distributions).toEqual([distribution]);
    expect(result.current.chartBundle?.volume_distributions).toEqual([distribution]);
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
    useRangeSpy
      .mockReturnValueOnce({ data: null, isLoading: false, error: null, isPlaceholderData: false, isFetching: false })
      .mockReturnValueOnce({ data: sidecarBundle, isLoading: false, error: null, isPlaceholderData: false, isFetching: false });

    const { result } = renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });

    expect(result.current.chartBundle?.program_trade?.points).toEqual([programPoint]);
    expect(result.current.bundle?.program_trade?.points).toEqual([programPoint]);
  });

  it('clamps pastFrom to 249 days before today when historicalFromDate is older', () => {
    useLivePageStore.setState({ historicalFromDate: '20250101' });
    renderHook(() => useLiveBundle('005930', '1m', '20260527', liveFixture), { wrapper });
    expect(livePastCandlesSpy).toHaveBeenCalledWith('005930', '20250920', '20260527', 'KRX');
    // 5th arg = priceRange (undefined here); 6th = todayKst, which drives the
    // 5-min refetch that advances pastMaxQrT (review C1). minutePastTo === today
    // so todayKst === to === '20260527'.
    expect(useRangeSpy).toHaveBeenCalledWith(
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

    expect(useRangeSpy).toHaveBeenCalledWith(
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

    expect(useRangeSpy).toHaveBeenCalledWith(
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
    useRangeSpy.mockClear();
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
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
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
    rangeMock.isPlaceholderData = false;
    rangeMock.isFetching = false;
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
    rerender({ live: liveWithOb(1779840120000) });
    expect(result.current.chartBundle).toBe(settled); // HELD

    // Both fresh again → released to the fresh computedChartBundle (a new object).
    rangeMock.isPlaceholderData = false;
    rangeMock.isFetching = false;
    rerender({ live: liveWithOb(1779840120000) });
    expect(result.current.chartBundle).not.toBe(settled); // RELEASED
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
    candlesMock.candles = [DEFAULT_CANDLE];
    candlesMock.isPlaceholderData = false;
    candlesMock.isFetching = false;
    candlesMock.warnings = [];
    rangeMock.isPlaceholderData = false;
    rangeMock.isFetching = false;
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
});
