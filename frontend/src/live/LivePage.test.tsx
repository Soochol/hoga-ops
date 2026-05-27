import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LivePage } from './LivePage';
import { useLivePageStore } from '../state/livePage';
import * as liveStatus from '../api/liveStatus';

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
    initial: undefined, isLoading: false, error: null,
    ob: [], trade: [], broker: [],
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
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      watchlistPanelOpen: false,
    });
    vi.spyOn(liveStatus, 'useLiveStatus').mockReturnValue({
      data: {
        running: true,
        started_at_ms: 1,
        last_tick_ms: 1,
        cycle_lag_ms: 100,
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

  it('falls back to localStorage activeCode when no query param', () => {
    useLivePageStore.setState({ activeCode: '035720' } as any);
    renderWithRouter();
    expect(screen.getByTestId('live-status-bar').textContent).toContain('035720');
  });

  it('shows empty-state placeholder when no activeCode anywhere', () => {
    renderWithRouter();
    // Empty state placeholder in workarea
    expect(screen.getByTestId('live-workarea').textContent).toMatch(/관심종목/);
  });
});
