import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import type { RangeBundle } from '../api/types';
import { useLivePageStore } from '../state/livePage';
import { useLiveTabsStore } from '../state/liveTabs';
import { useLiveVenueStore } from '../state/liveVenue';
import * as liveStatus from '../api/liveStatus';

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
    liveChartRootProps: [] as Array<{
      code?: string | null;
      timeframe?: string;
      viewIdentity?: string;
      chartBundle?: RangeBundle | null;
      paneTogglesOverride?: { hogaPanes?: boolean };
    }>,
    liveBundleCalls: [] as Array<{ code: unknown; timeframe: unknown; options: { venue?: string } }>,
    liveBundleResult: {
      bundle: null as RangeBundle | null,
      chartBundle: null as RangeBundle | null,
    },
    indexCandlesCalls: [] as unknown[],
    indexCandlesResult: {
      data: undefined as unknown,
      isLoading: false,
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
  LiveChartRoot: (props: { code?: string | null; timeframe?: string; viewIdentity?: string }) => {
    livePageMocks.liveChartRootProps.push(props);
    return null;
  },
}));

// LiveSidebar reads live status via useLiveSeries (EventSource), which isn't
// available in jsdom. Mock the hook so the shell tests stay unit-level.
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: { ask_peak_today: livePageMocks.todayAskPeak, bid_peak_today: null }, isLoading: false, error: null,
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

// LiveSidebar now calls cursor hooks (ADR-0044) — mock them so the shell
// tests stay unit-level and don't trigger useSpot/apiGet in jsdom.
vi.mock('../api/useLiveCursor', () => ({
  useLiveOrderbookAtCursor: () => undefined,
  useLiveBrokersAtCursor: () => undefined,
}));

// useLiveBannerState now reads the authoritative watchlist via useWatchlist;
// mock it non-empty so the banner logic stays unit-level and doesn't hit
// /api/watchlist in jsdom. (Empty-state is exercised in useLiveBannerState.test.ts.)
// useAddToWatchlist / useRemoveFromWatchlist are also stubbed because
// LiveSymbolSearch (mounted in LiveHeader) calls them.
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
  useLiveBundle: (code: unknown, timeframe: unknown, _today: unknown, _live: unknown, options?: { venue?: string }) => {
    livePageMocks.liveBundleCalls.push({ code, timeframe, options: options ?? {} });
    return {
      ...livePageMocks.liveBundleResult,
      isLoading: false,
      error: null,
      clampEngaged: false,
      isPastCandlesLoading: false,
    };
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
    investorPoints: [],
    ask_peaks: [],
    bid_peaks: [],
    ...overrides,
  };
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
    livePageMocks.liveBundleResult.bundle = null;
    livePageMocks.liveBundleResult.chartBundle = null;
    livePageMocks.indexCandlesCalls.length = 0;
    livePageMocks.indexCandlesResult.data = undefined;
    livePageMocks.indexCandlesResult.isLoading = false;
    livePageMocks.indexInvestorNetCalls.length = 0;
    livePageMocks.indexInvestorNetResult.data = undefined;
    livePageMocks.indexInvestorNetResult.isLoading = false;
    livePageMocks.dayAskPeakTodayArgs.length = 0;
    livePageMocks.allPriceObArgs.length = 0;
    livePageMocks.allPriceTodayArgs.length = 0;
    livePageMocks.currentStudySaveSource = null;
    livePageMocks.dayBidPeaksResult = null;
    // The tabs store is a module singleton (loaded once at import). The new
    // LivePage tab-bar wiring makes the mount-seed effect read its activeTabId,
    // so reset it per-test to keep tests isolated — without this, a tab opened
    // by one test's ?code= leaks into the next test's restored-active-tab path.
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
    });
    useLiveVenueStore.setState({ venue: 'KRX' });
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

  it('renders the four rows of the grid', () => {
    renderWithRouter();
    expect(screen.getByTestId('live-header')).toBeInTheDocument();
    expect(screen.getByTestId('live-status-bar')).toBeInTheDocument();
    expect(screen.getByTestId('live-toolbar')).toBeInTheDocument();
    expect(screen.getByTestId('live-workarea')).toBeInTheDocument();
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
    expect(useLiveTabsStore.getState().tabs[0].instrument).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
    });
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
    useLivePageStore.setState({ candleTimeframe: 'D' });

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
    useLivePageStore.setState({
      candleTimeframe: 'D',
      historicalFromDate: '20260619',
      foreignNetEnabled: true,
      institutionNetEnabled: false,
    });

    renderWithRouter('/live?index=KOSPI');

    await waitFor(() => expect(livePageMocks.indexInvestorNetCalls.length).toBeGreaterThan(0));
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
    useLivePageStore.setState({
      candleTimeframe: 'D',
      historicalFromDate: '20260619',
      foreignNetEnabled: true,
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

  it('falls back to the restored active tab when no query param', () => {
    // 단일-탭 모델: 복원된 활성 탭이 page.activeCode의 단일 writer다(stray activeCode가
    // 아니라 탭이 진실). 마운트 시드가 focusTab → applyTabToPage 로 동기화한다.
    const id = 'restored';
    useLiveTabsStore.setState({
      tabs: [{ id, code: '035720', label: '035720', timeframe: '1m', historicalFromDate: null, viewport: null }],
      activeTabId: id,
    });
    renderWithRouter();
    expect(screen.getByTestId('live-status-bar').textContent).toContain('035720');
  });

  it('passes the active tab id as chart view identity so same-code tabs do not share viewport state', () => {
    useLiveTabsStore.setState({
      tabs: [
        { id: 'tab-a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null },
        { id: 'tab-b', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null },
      ],
      activeTabId: 'tab-b',
    });

    renderWithRouter();

    expect(livePageMocks.liveChartRootProps.at(-1)).toMatchObject({
      code: '005930',
      timeframe: '1m',
      viewIdentity: 'tab-b:KRX',
    });
  });

  it('includes the selected venue in bundle options, status text, and chart identity', () => {
    useLiveVenueStore.setState({ venue: 'AUTO' });
    useLiveTabsStore.setState({
      tabs: [{ id: 'tab-a', code: '005930', label: '삼성전자', timeframe: '1m', historicalFromDate: null, viewport: null }],
      activeTabId: 'tab-a',
    });

    renderWithRouter();

    expect(livePageMocks.liveBundleCalls.at(-1)?.options.venue).toBe('AUTO');
    expect(screen.getByTestId('live-venue-label').textContent).toBe('캔들 자동');
    expect(livePageMocks.liveChartRootProps.at(-1)?.viewIdentity).toBe('tab-a:AUTO');
  });

  it('shows empty-state placeholder when no activeCode anywhere', () => {
    renderWithRouter();
    // Empty state placeholder in workarea
    expect(screen.getByTestId('live-workarea').textContent).toMatch(/검색하세요/);
  });

  it('store write (search/♥ select) wins over a ?code= deep link — store is the single SoT', async () => {
    // Mount at /live?code=005930 → the deep-link code seeds the store once.
    renderWithRouter('/live?code=005930');
    // After the mount-seed effect, the active code is 005930.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('005930'));
    // Now simulate a search / ♥ selection writing a DIFFERENT code to the store.
    act(() => useLivePageStore.getState().setActiveCode('000660'));
    // It must STICK — the URL must not revert it back to 005930.
    expect(useLivePageStore.getState().activeCode).toBe('000660');
    // And it must not flip back across a re-render.
    await waitFor(() => expect(useLivePageStore.getState().activeCode).toBe('000660'));
  });

  it('passes live orderbook snapshots to ask-peak ratchet on minute timeframes', () => {
    useLivePageStore.setState({ candleTimeframe: '1m' });
    renderWithRouter('/live?code=005930');
    expect(livePageMocks.dayAskPeakObArgs.at(-1)).toBe(livePageMocks.liveOb);
    expect(livePageMocks.dayAskPeakTradeArgs.at(-1)).toBe(livePageMocks.liveTrade);
    expect(livePageMocks.allPriceObArgs.at(-1)).toBe(livePageMocks.liveOb);
  });

  it('does not feed live orderbook snapshots into ask-peak ratchet on calendar timeframes', () => {
    useLivePageStore.setState({ candleTimeframe: 'D' });
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
});
