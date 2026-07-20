import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import type { RangeBundle } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import { useWorkspaceStore } from '../state/workspace';
import type { IndicatorSettingsByTimeframe } from '../state/indicatorSettingsV2';
import { useLiveVenueStore } from '../state/liveVenue';
import { DEFAULT_CARD_WEIGHTS, DEFAULT_RIGHT_PANEL_WIDTH_PX, useLiveLayoutStore } from '../state/liveLayout';
import * as liveStatus from '../api/liveStatus';
import { initialHistoricalDaysFor, subtractDaysKst, todayKstYyyymmdd } from './liveDateTime';
import type { LiveTimeframe } from '../state/livePage';

const livePageMocks = vi.hoisted(() => {
  const liveOb = [{
    t_ms: 1,
    total_ask_qty: 100,
    total_bid_qty: 90,
    asks: [{ price: 1000, qty: 10 }],
    bids: [{ price: 990, qty: 9 }],
  }];
  const liveTrade = [{
    t_ms: 1,
    trades: [{ t_ms: 1, side: 1, price: 1000, qty: 5 }],
  }];
  return {
    liveOb,
    liveTrade,
    indicatorPanelProps: [] as Array<{ timeframe: LiveTimeframe }>,
    liveChartRootProps: [] as Array<{
      code?: string | null;
      timeframe?: string;
      viewIdentity?: string;
      restoreViewport?: unknown;
      onViewportCaptureReady?: (capture: () => unknown) => void;
      chartBundle?: RangeBundle | null;
      tradeVolumePocs?: unknown[];
      isExtending?: boolean;
      pastDataWarnings?: Array<{ reason: string; msg?: string }>;
      paneTogglesOverride?: { hogaPanes?: boolean };
      dayAskPeaks?: unknown[];
      todayAllPriceAskPeak?: unknown;
      dayBidPeaks?: unknown[];
      todayAllPriceBidPeak?: unknown;
    }>,
    liveBundleCalls: [] as Array<{
      code: unknown;
      timeframe: unknown;
      options: { investorNetEnabled?: boolean; venue?: string };
    }>,
    liveBundleResult: {
      bundle: null as RangeBundle | null,
      chartBundle: null as RangeBundle | null,
      hogaBundle: null as RangeBundle | null,
    },
    indexCandlesCalls: [] as unknown[],
    indexCandlesResult: {
      data: undefined as unknown,
      isLoading: false,
      isFetching: false,
    },
    indexInvestorNetCalls: [] as unknown[],
    indexInvestorNetResult: {
      data: undefined as unknown,
      isLoading: false,
    },
    dayAskPeakObArgs: [] as unknown[],
    dayAskPeakTradeArgs: [] as unknown[],
    dayAskPeakTodayArgs: [] as unknown[],
    allPriceObArgs: [] as unknown[],
    allPriceTodayArgs: [] as unknown[],
    currentStudySaveSource: null as unknown,
    dayBidPeaksResult: null as unknown[] | null,
    tradeVolumePocsResult: [] as unknown[],
    todayAskPeak: {
      date: '20260616',
      coverage: 'partial',
      traded_price: 70000,
      traded_qty: 1000,
      traded_t_ms: 1,
      all_price: 70100,
      all_qty: 1500,
      all_t_ms: 2,
    },
  };
});

// jsdom does not implement ResizeObserver — provide a no-op stub.
if (typeof window !== 'undefined' && !window.ResizeObserver) {
  window.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// LiveWorkarea now mounts LiveChartRoot (single chart, 5 panes) when an
// activeCode is set. Mock LiveChartRoot so the shell tests stay unit-level
// and don't have to model lightweight-charts' full v5 series/timeScale API.
vi.mock('./LiveChartRoot', () => ({
  LiveChartRoot: (props: {
    code?: string | null;
    timeframe?: string;
    viewIdentity?: string;
    restoreViewport?: unknown;
    onViewportCaptureReady?: (capture: () => unknown) => void;
  }) => {
    livePageMocks.liveChartRootProps.push(props);
    return null;
  },
}));

// LiveSidebar reads live status via useLiveSeries (EventSource), which isn't
// available in jsdom. Mock the hook so the shell tests stay unit-level.
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: (code: string) => ({
    initial: { code, ask_peak_today: livePageMocks.todayAskPeak, bid_peak_today: null }, isLoading: false, error: null,
    ob: livePageMocks.liveOb, trade: livePageMocks.liveTrade, broker: [],
  }),
}));

vi.mock('./useDayAskPeaks', () => ({
  useTodayAllPriceAskPeak: (ob: unknown, _seeds: unknown, _today: unknown, _code: unknown, todayAskPeak: unknown) => {
    livePageMocks.allPriceObArgs.push(ob);
    livePageMocks.allPriceTodayArgs.push(todayAskPeak);
    return null;
  },
  useDayAskPeaks: (ob: unknown, trade: unknown, seeds: unknown, _today: unknown, _code: unknown, todayAskPeak: unknown) => {
    livePageMocks.dayAskPeakObArgs.push(ob);
    livePageMocks.dayAskPeakTradeArgs.push(trade);
    livePageMocks.dayAskPeakTodayArgs.push(todayAskPeak);
    return seeds ?? [];
  },
}));

vi.mock('./useDayBidPeaks', () => ({
  useTodayAllPriceBidPeak: () => null,
  useDayBidPeaks: (_ob: unknown, _trade: unknown, seeds: unknown) => livePageMocks.dayBidPeaksResult ?? seeds ?? [],
}));

vi.mock('./useTradeVolumePoc', () => ({
  useTradeVolumePocs: () => livePageMocks.tradeVolumePocsResult,
}));

// LiveSidebar now calls cursor hooks (ADR-0044) — mock them so the shell
// tests stay unit-level and don't trigger useSpot/apiGet in jsdom.
vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: () => undefined,
  useLiveBrokersAtCursor: () => undefined,
}));

// useLiveBannerState now reads the authoritative watchlist via useWatchlist;
// mock it non-empty so the banner logic stays unit-level and doesn't hit
// /api/watchlist in jsdom. (Empty-state is exercised in useLiveBannerState.test.ts.)
// useAddToWatchlist / useRemoveFromWatchlist are stubbed defensively; the
// symbol search now lives in the global TopNav, but other live surfaces still
// touch these hooks in jsdom.
vi.mock('../watchlist/useWatchlist', () => ({
  useWatchlist: () => ({ data: { entries: [{ code: '000660' }], next_run_at_ms: 0 } }),
  useAddToWatchlist: () => ({ mutate: vi.fn() }),
  useRemoveFromWatchlist: () => ({ mutate: vi.fn() }),
}));

vi.mock('../api/liveIndices', () => ({
  useLiveIndices: () => ({ data: [] }),
  useLiveIndexCandles: (...args: unknown[]) => {
    livePageMocks.indexCandlesCalls.push(args);
    return livePageMocks.indexCandlesResult;
  },
  useLiveIndexInvestorNet: (...args: unknown[]) => {
    livePageMocks.indexInvestorNetCalls.push(args);
    return livePageMocks.indexInvestorNetResult;
  },
}));

// LivePage now owns the single useLiveBundle call. Mock to avoid TanStack
// queries hitting real endpoints in the shell test.
vi.mock('./useLiveBundle', () => ({
  useLiveBundle: (
    code: unknown,
    timeframe: unknown,
    _today: unknown,
    _live: unknown,
    options?: { investorNetEnabled?: boolean; venue?: string },
  ) => {
    livePageMocks.liveBundleCalls.push({ code, timeframe, options: options ?? {} });
    return {
      ...livePageMocks.liveBundleResult,
      isLoading: false,
      error: null,
      clampEngaged: false,
      isPastCandlesLoading: false,
      pastDataWarnings: [],
      hogaCoverageGapDates: [],
    };
  },
}));

vi.mock('./indicators/IndicatorPanel', () => ({
  default: ({ onClose, timeframe }: { onClose: () => void; timeframe: LiveTimeframe }) => {
    livePageMocks.indicatorPanelProps.push({ timeframe });
    return (
      <div role="dialog" aria-label="지표">
        <button type="button" onClick={onClose}>닫기</button>
      </div>
    );
  },
}));

vi.mock('../studyViews/studySaveSource', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../studyViews/studySaveSource')>();
  return {
    ...actual,
    setCurrentStudySaveSource: (source: unknown) => {
      livePageMocks.currentStudySaveSource = source;
    },
    clearCurrentStudySaveSource: (source: unknown) => {
      if (livePageMocks.currentStudySaveSource === source) {
        livePageMocks.currentStudySaveSource = null;
      }
    },
  };
});

vi.mock('../capture/useSymbols', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../capture/useSymbols')>();
  return {
    ...actual,
    // 심볼 마스터 스텁 — 000660만 실명 해석. 005930은 목록에 없어 미해석 폴백
    // (탭 타이틀 테스트의 document.title === '005930' 단언)을 그대로 유지한다.
    useSymbols: () => ({
      data: { symbols: [{ code: '000660', name: 'SK하이닉스', market: 'KOSPI' }] },
    } as unknown as ReturnType<typeof actual.useSymbols>),
  };
});

function rangeBundleFixture(overrides: Partial<RangeBundle> = {}): RangeBundle {
  return {
    code: '005930',
    from_date: '20260616',
    to_date: '20260616',
    bucket_ms: 300_000,
    segments: [{ date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 }],
    candles: [
      { ts_ms: 1_000, open: 1, high: 2, low: 1, close: 2, vol_a: 10, vol_b: 0 },
      { ts_ms: 2_000, open: 2, high: 3, low: 2, close: 3, vol_a: 11, vol_b: 0 },
    ],
    quote_ratio: {
      bucket_ms: 300_000,
      points: [{ t: 1_000, bid_total: 100, ask_total: 90, bid_max: 0, ask_max: 0, imb_max_bid: 0, imb_max_ask: 0 }],
    },
    fill_strength: { bucket_ms: 300_000, points: [{ t: 1_000, buy_qty: 5, sell_qty: 4 }] },
    volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
    volume_profile_by_day: [],
    volume_distributions: overrides.volume_distributions ?? [],
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    broker_late_entries: [],
    ...overrides,
  };
}

// 멀티창 플립(ADR-0119 C2c-2d): 파이프라인은 차트 창 안에서 돈다. 셸 테스트는
// 단일 차트 창(TEST_WIN)을 시드하고, 봉/지표는 창의 chart 설정으로 주입한다.
const TEST_WIN = 'w-test';
function seedWorkspace(
  timeframe: LiveTimeframe = '1m',
  byTimeframe: IndicatorSettingsByTimeframe = {},
) {
  useWorkspaceStore.setState({
    windows: [{
      id: TEST_WIN,
      kind: 'chart',
      group: 1,
      rect: { x: 0, y: 0, w: 800, h: 600 },
      chart: { timeframe, indicators: { paneOrder: [], paneStretch: {}, byTimeframe } },
    }],
    zOrder: [TEST_WIN],
    groupSymbols: {},
    chartRuntime: {},
  });
}

function renderWithRouter(initial = '/live') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Routes>
          <Route path="/live" element={<LivePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LivePage shell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.title = 'before-test';
    livePageMocks.dayAskPeakObArgs.length = 0;
    livePageMocks.dayAskPeakTradeArgs.length = 0;
    livePageMocks.liveChartRootProps.length = 0;
    livePageMocks.liveBundleCalls.length = 0;
    livePageMocks.indicatorPanelProps.length = 0;
    livePageMocks.liveBundleResult.bundle = null;
    livePageMocks.liveBundleResult.chartBundle = null;
    livePageMocks.liveBundleResult.hogaBundle = null;
    livePageMocks.indexCandlesCalls.length = 0;
    livePageMocks.indexCandlesResult.data = undefined;
    livePageMocks.indexCandlesResult.isLoading = false;
    livePageMocks.indexCandlesResult.isFetching = false;
    livePageMocks.indexInvestorNetCalls.length = 0;
    livePageMocks.indexInvestorNetResult.data = undefined;
    livePageMocks.indexInvestorNetResult.isLoading = false;
    livePageMocks.dayAskPeakTodayArgs.length = 0;
    livePageMocks.allPriceObArgs.length = 0;
    livePageMocks.allPriceTodayArgs.length = 0;
    livePageMocks.currentStudySaveSource = null;
    livePageMocks.dayBidPeaksResult = null;
    livePageMocks.tradeVolumePocsResult = [];
    // 단일 뷰 모델(ADR-0113): 마운트 시드는 복원된 activeInstrument를 읽으므로
    // 매 테스트마다 page 스토어의 subject를 리셋해 격리한다.
    useLivePageStore.setState({
      activeInstrument: null,
      activeCode: null,
      candleTimeframe: '1m',
      historicalFromDate: null,
    });
    seedWorkspace('1m');
    useLiveVenueStore.setState({ venue: 'KRX' });
    useLiveLayoutStore.setState({
      rightPanelWidthPx: DEFAULT_RIGHT_PANEL_WIDTH_PX,
      rightCardWeights: DEFAULT_CARD_WEIGHTS,
    });
    vi.spyOn(liveStatus, 'useLiveStatus').mockReturnValue({
      data: {
        running: true,
        started_at_ms: 1,
        last_tick_ms: 1,
        cycle_lag_ms: 100,
        capture_healthy: true,
        capture_reason: 'healthy',
        watchlist_count: 1,
        kis_calls_today: 0,
        kis_rate_limit_remaining: null,
      },
      isLoading: false,
    } as unknown as ReturnType<typeof liveStatus.useLiveStatus>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the flip chrome: status bar + workspace toolbar + canvas window', () => {
    renderWithRouter('/live?code=000660');
    expect(screen.getByTestId('live-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('workspace-live-toolbar')).toBeInTheDocument();
    // 봉 컨트롤은 창 소유(#708) — 차트 창 상단에 렌더된다.
    expect(screen.getByRole('button', { name: '분봉 선택 열기: 1분' })).toBeInTheDocument();
  });

  // 열 축을 비워두면 grid-auto-columns:auto 가 되고, 그 트랙은 가장 넓은 자식(탈출구가
  // 없는 LiveStatusBar)의 min-content 폭에서 바닥을 친다. 그러면 캔버스가 컨테이너보다
  // 넓게 늘어난 채 App 의 <main overflow-hidden> 에 잘려 우측이 사라진다. 행 축은 이미
  // 같은 이유로 minmax(0,1fr) 을 쓰고 있다 — 두 축을 함께 잠근다.
  it('constrains both root grid axes so narrowing shrinks the canvas instead of clipping it', () => {
    renderWithRouter('/live?code=000660');

    let root: HTMLElement | null = screen.getByTestId('live-status-bar');
    while (root && !root.style.gridTemplateRows) root = root.parentElement;

    expect(root).not.toBeNull();
    expect(root!.style.gridTemplateRows).toContain('minmax(0, 1fr)');
    expect(root!.style.gridTemplateColumns).toBe('minmax(0, 1fr)');
  });

  it('shows the collect button for a stock code and opens the collect dialog with the symbol name', async () => {
    renderWithRouter('/live?code=000660');

    act(() => {
      screen.getByTestId('live-collect-button').click();
    });

    // 딥링크 시드는 label=code 지만, 제목은 심볼 마스터의 실명으로 보강된다.
    const dialog = await screen.findByRole('dialog', { name: 'SK하이닉스 지난 N일 수집' });
    // 단일 종목 스코프 — 대상 1종목이 그대로 노출된다.
    expect(dialog.textContent).toContain('1');
  });

  it('hides the collect button for index instruments', async () => {
    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(useLivePageStore.getState().activeInstrument?.kind).toBe('index'));
    expect(screen.getByTestId('workspace-live-toolbar')).toBeInTheDocument();
    expect(screen.queryByTestId('live-collect-button')).toBeNull();
  });

  it('passes the focused chart window timeframe into IndicatorPanel', async () => {
    seedWorkspace('D');

    renderWithRouter('/live?code=000660');
    act(() => {
      screen.getByTestId('live-indicators-button').click();
    });

    await waitFor(() => expect(livePageMocks.indicatorPanelProps.at(-1)?.timeframe).toBe('D'));
    expect(screen.getByRole('dialog', { name: '지표' })).toBeInTheDocument();
  });

  it('enables stock investor net fetches from the window D bucket', async () => {
    seedWorkspace('D', { D: { foreignNetEnabled: true } });

    renderWithRouter('/live?code=000660');

    await waitFor(() => expect(livePageMocks.liveBundleCalls.some((call) =>
      call.code === '000660'
      && call.timeframe === 'D'
      && call.options.investorNetEnabled === true)).toBe(true));
  });

  it('reads activeCode from ?code= query param', () => {
    renderWithRouter('/live?code=000660');
    // The status bar surfaces the code somewhere visible
    expect(screen.getByTestId('live-status-bar').textContent).toContain('000660');
  });

  it('reads active index from ?index= query param without setting activeCode', async () => {
    renderWithRouter('/live?index=KOSPI');
    await waitFor(() => expect(useLivePageStore.getState().activeInstrument).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    }));
    expect(useLivePageStore.getState().activeCode).toBeNull();
  });

  it('renders an index chart bundle for daily index deep links', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    seedWorkspace('D');

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: 'D',
    }));
    const lastIndexCall = livePageMocks.indexCandlesCalls.at(-1) as unknown[] | undefined;
    expect(lastIndexCall?.[0]).toBe('KOSPI');
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.candles[0].close).toBe(2855.67);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.quote_ratio.points).toEqual([]);
    expect(livePageMocks.liveChartRootProps.at(-1)?.paneTogglesOverride?.hogaPanes).toBe(false);
  });

  it('renders an index chart bundle for minute index deep links', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: '1m',
      candles: [
        {
          t_ms: 1_781_829_000_000,
          open: 2850.10,
          high: 2852.34,
          low: 2849.87,
          close: 2851.67,
          volume: 123456,
        },
      ],
      data_warnings: [],
    };
    seedWorkspace('1m');

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: '1m',
    }));
    const lastIndexCall = livePageMocks.indexCandlesCalls.at(-1) as unknown[] | undefined;
    expect(lastIndexCall?.[0]).toBe('KOSPI');
    expect(lastIndexCall?.[1]).toBe('1m');
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.bucket_ms).toBe(60_000);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.candles[0].close).toBe(2851.67);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.quote_ratio.points).toEqual([]);
    expect(livePageMocks.liveChartRootProps.at(-1)?.paneTogglesOverride?.hogaPanes).toBe(false);
  });

  it.each(['1m', 'D', 'W', 'M'] as const)(
    'fetches index %s candles from the same initial history window as stock charts',
    async (timeframe: LiveTimeframe) => {
      seedWorkspace(timeframe);

      renderWithRouter('/live?index=KOSPI');

      await waitFor(() => {
        expect(livePageMocks.indexCandlesCalls.some((args) => {
          const call = args as unknown[];
          return call[0] === 'KOSPI' && call[1] === timeframe;
        })).toBe(true);
      });
      const call = (livePageMocks.indexCandlesCalls as unknown[][]).find((args) =>
        args[0] === 'KOSPI' && args[1] === timeframe,
      );
      expect(call?.[2]).toBe(subtractDaysKst(todayKstYyyymmdd(), initialHistoricalDaysFor(timeframe)));
    },
  );

  it('marks index charts as extending while a historical index fetch is in flight', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260619',
      timeframe: 'W',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    livePageMocks.indexCandlesResult.isFetching = true;
    seedWorkspace('W');

    renderWithRouter('/live?index=KOSPI');
    act(() => {
      useWorkspaceStore.getState().extendChartHistoricalRange(TEST_WIN, '20200101');
    });

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: 'W',
      isExtending: true,
    }));
  });

  it('passes index candle data warnings through to the chart surface', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260622',
      timeframe: '1m',
      candles: [
        {
          t_ms: 1_782_103_980_000,
          open: 2850.10,
          high: 2852.34,
          low: 2849.87,
          close: 2851.67,
          volume: 123456,
        },
      ],
      data_warnings: [
        { batch: '20260601__20260622', date: '20260622', reason: 'index_minute_depth_limited', msg: 'limited' },
      ],
    };
    seedWorkspace('1m');
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260601', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: 'index:KOSPI',
      timeframe: '1m',
      pastDataWarnings: [
        expect.objectContaining({ reason: 'index_minute_depth_limited' }),
      ],
    }));
  });

  it('hydrates KOSPI daily index charts with market investor net points', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [
        {
          t_ms: 1_781_830_800_000,
          open: 2840.12,
          high: 2861.34,
          low: 2833.2,
          close: 2855.67,
          volume: 450000000,
        },
      ],
      data_warnings: [],
    };
    livePageMocks.indexInvestorNetResult.data = {
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      points: [
        { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
      ],
      data_warnings: [],
    };
    seedWorkspace('D', { D: { foreignNetEnabled: true } });
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260619', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.indexInvestorNetCalls.length).toBeGreaterThan(0));
    expect(livePageMocks.liveBundleCalls.at(-1)?.options.investorNetEnabled).toBe(true);
    const lastInvestorCall = livePageMocks.indexInvestorNetCalls.at(-1) as unknown[] | undefined;
    expect(lastInvestorCall?.[0]).toBe('KOSPI');
    expect(lastInvestorCall?.[1]).toBe('20260619');
    expect(lastInvestorCall?.[3]).toBe(true);
    expect(livePageMocks.liveChartRootProps.at(-1)?.chartBundle?.investorPoints).toEqual([
      { t_ms: 1_781_830_800_000, foreign_net: -3519, institution_net: 17184 },
    ]);
  });

  it('does not fetch investor net for non-market representative indices', async () => {
    livePageMocks.indexCandlesResult.data = {
      index_id: 'KOSPI200',
      from: '20260619',
      to: '20260619',
      timeframe: 'D',
      candles: [],
      data_warnings: [],
    };
    seedWorkspace('D', { D: { foreignNetEnabled: true } });
    useWorkspaceStore.setState({
      chartRuntime: { [TEST_WIN]: { historicalFromDate: '20260619', lastMinuteHistoricalFromDate: null } },
    });

    renderWithRouter('/live?index=KOSPI200');

    await waitFor(() => expect(livePageMocks.indexCandlesCalls.length).toBeGreaterThan(0));
    const lastInvestorCall = livePageMocks.indexInvestorNetCalls.at(-1) as unknown[] | undefined;
    expect(lastInvestorCall?.[0]).toBeNull();
    expect(lastInvestorCall?.[3]).toBe(false);
  });

  it('sets the browser tab title from the active Code on /live', async () => {
    renderWithRouter('/live?code=005930');
    await waitFor(() => expect(document.title).toBe('005930'));
  });

  it('falls back to the restored workspace group symbol when no query param', () => {
    // 플립 후 종목 SSOT = live.workspace.v1 의 groupSymbols(활성 그룹) 복원.
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '035720', name: '035720' } } });
    renderWithRouter();
    expect(screen.getByTestId('live-status-bar').textContent).toContain('035720');
  });

  it('passes activeCode:venue as chart view identity (창별)', () => {
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });

    renderWithRouter();

    expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: '005930',
      timeframe: '1m',
      viewIdentity: '005930:KRX',
    });
  });

  it('does not restore logical viewport across minute timeframe changes', async () => {
    const capturedViewport = {
      rightEdgeMs: 1_781_000_000_000,
      barSpan: 331,
      atLiveEdge: true,
    };
    renderWithRouter('/live?code=005930');
    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.code).toBe('005930'));
    act(() => {
      livePageMocks.liveChartRootProps.at(-1)?.onViewportCaptureReady?.(() => capturedViewport);
    });

    act(() => {
      screen.getByRole('button', { name: '분봉 선택 열기: 1분' }).click();
    });
    act(() => {
      screen.getByRole('menuitemradio', { name: '3분' }).click();
    });

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.timeframe).toBe('3m'));
    // 창 tf 가 스토어에도 커밋됐는지(창 소유) — 뷰포트는 비저장(#713)이라 prop 없음.
    expect(useWorkspaceStore.getState().windows[0].chart?.timeframe).toBe('3m');
  });

  it('includes the selected venue in bundle options, status text, and chart identity', () => {
    useLiveVenueStore.setState({ venue: 'UN' });
    useWorkspaceStore.setState({ groupSymbols: { 1: { code: '005930', name: '삼성전자' } } });

    renderWithRouter();

    expect(livePageMocks.liveBundleCalls.at(-1)?.options.venue).toBe('UN');
    expect(screen.getByTestId('live-venue-label').textContent).toBe('캔들 통합');
    expect(livePageMocks.liveChartRootProps.at(-1)?.viewIdentity).toBe('005930:UN');
  });

  it('shows the per-window placeholder when the active group has no symbol', () => {
    renderWithRouter();
    expect(screen.getByText(/종목 없음/)).toBeInTheDocument();
  });

  it('closes the indicator drawer when the last chart window disappears (리뷰 #3 latch)', async () => {
    renderWithRouter('/live?code=005930');
    act(() => { screen.getByTestId('live-indicators-button').click(); });
    // IndicatorPanel 은 이 스위트에서 role=dialog "지표" 로 목킹된다.
    await screen.findByRole('dialog', { name: '지표' });
    // 유일한 차트 창을 제거 → 드로어 null 렌더 + latch effect 로 open 플래그 정리.
    act(() => { useWorkspaceStore.setState({ windows: [], zOrder: [], chartRuntime: {} }); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '지표' })).toBeNull());
  });


  it('shows the canvas-level empty state when there are no windows', () => {
    useWorkspaceStore.setState({ windows: [], zOrder: [], chartRuntime: {} });
    renderWithRouter();
    expect(screen.getByTestId('workspace-empty-add-chart')).toBeInTheDocument();
  });

  it('search write wins over a ?code= deep link — workspace 활성 그룹이 단일 SoT', async () => {
    renderWithRouter('/live?code=005930');
    // 딥링크 1회 시드 → 활성 그룹 종목 + 레거시 미러.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('005930'));
    // 검색/♥ 선택이 다른 종목을 활성 그룹에 쓴다.
    act(() => {
      useWorkspaceStore.getState().setGroupSymbol(1, { code: '000660', name: 'SK하이닉스' });
    });
    expect(useWorkspaceStore.getState().groupSymbols[1]?.code).toBe('000660');
    // URL 이 되돌리지 않고, 미러도 000660 으로 수렴한다.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('000660'));
  });

  it('passes live orderbook snapshots to ask-peak ratchet on minute timeframes', () => {
    seedWorkspace('1m');
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayAskPeakObArgs.at(-1)).toBe(livePageMocks.liveOb);
    expect(livePageMocks.dayAskPeakTradeArgs.at(-1)).toBe(livePageMocks.liveTrade);
    expect(livePageMocks.allPriceObArgs.at(-1)).toBe(livePageMocks.liveOb);
  });

  it('does not feed live orderbook snapshots into ask-peak ratchet on calendar timeframes', () => {
    seedWorkspace('D');
    renderWithRouter('/live?code=005930');
    const ob = livePageMocks.dayAskPeakObArgs.at(-1);
    const trade = livePageMocks.dayAskPeakTradeArgs.at(-1);
    expect(ob).not.toBe(livePageMocks.liveOb);
    expect(ob).toEqual([]);
    expect(trade).not.toBe(livePageMocks.liveTrade);
    expect(trade).toEqual([]);
  });

  it('passes backend today ask-peak payload to useDayAskPeaks', () => {
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayAskPeakTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
    expect(livePageMocks.allPriceTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
  });

  it('does not pass stale ask-peak seeds from a bundle whose code differs from the active tab', async () => {
    const staleAskPeaks = [
      { date: '20260616', price: 53000, qty: 21_000, t_ms: 1, max_price: 53000, max_qty: 21_000, max_t_ms: 1 },
    ];
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      code: '005930',
      ask_peaks: staleAskPeaks,
    });
    livePageMocks.liveBundleResult.chartBundle = rangeBundleFixture({
      code: '005930',
      ask_peaks: staleAskPeaks,
    });

    renderWithRouter('/live?code=000660');

    await waitFor(() => expect(livePageMocks.liveChartRootProps.at(-1)?.code).toBe('000660'));
    expect(livePageMocks.dayAskPeakTodayArgs.at(-1)).toBe(livePageMocks.todayAskPeak);
    expect(livePageMocks.liveChartRootProps.at(-1)?.dayAskPeaks).toEqual([]);
  });

  it('preserves rendered bid_peaks in the live study save bundle when chartBundle is present', async () => {
    const askPeaks = [{ date: '20260616', price: 70100, qty: 1000, t_ms: 1, max_price: 70100, max_qty: 1000, max_t_ms: 1 }];
    const seedBidPeaks = [{ date: '20260616', price: 69900, qty: 1200, t_ms: 2, max_price: 69900, max_qty: 1200, max_t_ms: 2 }];
    const renderedBidPeaks = [{ date: '20260616', price: 69800, qty: 2200, t_ms: 3, max_price: 69800, max_qty: 2200, max_t_ms: 3 }];
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      quote_ratio: {
        bucket_ms: 300_000,
        points: [{ t: 1_000, bid_total: 500, ask_total: 400, bid_max: 5, ask_max: 4, imb_max_bid: 3, imb_max_ask: 2 }],
      },
      ask_peaks: [],
      bid_peaks: [],
    });
    livePageMocks.liveBundleResult.chartBundle = rangeBundleFixture({
      from_date: '20260615',
      to_date: '20260616',
      ask_peaks: askPeaks,
      bid_peaks: seedBidPeaks,
    });
    livePageMocks.dayBidPeaksResult = renderedBidPeaks;

    renderWithRouter('/live?code=005930');

    await waitFor(() => {
      expect(livePageMocks.currentStudySaveSource).toMatchObject({
        origin: 'live',
        code: '005930',
        bundle: {
          ask_peaks: askPeaks,
          bid_peaks: renderedBidPeaks,
        },
      });
    });
  });

  it('publishes raw chart data in the live study save source without indicator copies', async () => {
    livePageMocks.liveBundleResult.bundle = rangeBundleFixture({
      from_date: '20260615',
      to_date: '20260616',
      segments: [
        { date: '20260615', session_open_ms: 500, session_close_ms: 900 },
        { date: '20260616', session_open_ms: 1_000, session_close_ms: 2_000 },
      ],
    });
    livePageMocks.tradeVolumePocsResult = [{
      date: '20260616',
      centerPrice: 70_000,
      lowPrice: 69_500,
      highPrice: 70_500,
      qty: 12_345,
      t_ms: 1_000,
      bandPct: 0.0025,
    }];
    seedWorkspace('1m', {
      minute: {
        dailyMovingAverageEnabled: true,
        dailyMovingAverageHidden: true,
        dailyMovingAverages: [
          { id: 'dma-20', enabled: true, period: 20, color: '#EAB308', lineWidth: 2, source: 'close' },
        ],
        tradeVolumePocEnabled: true,
        tradeVolumePocBandPct: 0.0025,
        tradeVolumePocColor: '#22C55E',
        tradeVolumePocOpacity: 0.28,
      },
    });

    renderWithRouter('/live?code=005930');

    await waitFor(() => {
      expect(livePageMocks.currentStudySaveSource).toMatchObject({
        origin: 'live',
        bundle: {
          trade_volume_pocs: [{
            date: '20260616',
            center_price: 70_000,
            low_price: 69_500,
            high_price: 70_500,
            qty: 12_345,
            t_ms: 1_000,
            band_pct: 0.0025,
          }],
        },
      });
      expect('indicatorState' in (livePageMocks.currentStudySaveSource as Record<string, unknown>)).toBe(false);
    });
  });
});
