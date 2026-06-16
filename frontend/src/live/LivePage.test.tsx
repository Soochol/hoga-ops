import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import { useLivePageStore } from '../state/livePage';
import { useLiveTabsStore } from '../state/liveTabs';
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
    dayAskPeakObArgs: [] as unknown[],
    dayAskPeakTradeArgs: [] as unknown[],
    dayAskPeakTodayArgs: [] as unknown[],
    allPriceObArgs: [] as unknown[],
    allPriceTodayArgs: [] as unknown[],
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
  LiveChartRoot: () => null,
}));

// LiveSidebar reads live status via useLiveSeries (EventSource), which isn't
// available in jsdom. Mock the hook so the shell tests stay unit-level.
vi.mock('../api/liveSeries', () => ({
  useLiveSeries: () => ({
    initial: { ask_peak_today: livePageMocks.todayAskPeak }, isLoading: false, error: null,
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

// LivePage now owns the single useLiveBundle call. Mock to avoid TanStack
// queries hitting real endpoints in the shell test.
vi.mock('./useLiveBundle', () => ({
  useLiveBundle: () => ({
    bundle: null,
    isLoading: false,
    error: null,
    clampEngaged: false,
    isPastCandlesLoading: false,
  }),
}));

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
    livePageMocks.dayAskPeakTodayArgs.length = 0;
    livePageMocks.allPriceObArgs.length = 0;
    livePageMocks.allPriceTodayArgs.length = 0;
    // The tabs store is a module singleton (loaded once at import). The new
    // LivePage tab-bar wiring makes the mount-seed effect read its activeTabId,
    // so reset it per-test to keep tests isolated — without this, a tab opened
    // by one test's ?code= leaks into the next test's restored-active-tab path.
    useLiveTabsStore.setState({ tabs: [], activeTabId: null });
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
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
});
