import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatchlistPanel } from './WatchlistPanel';
import { useLivePageStore } from '../state/livePage';
import * as watchlistApi from '../api/watchlist';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('WatchlistPanel', () => {
  beforeEach(() => {
    cleanup();
    useLivePageStore.setState({
      activeCode: null,
      candleTimeframe: '1m',
      watchlistPanelOpen: true,
    });
    vi.restoreAllMocks();
  });

  it('renders watchlist entries fetched from the API', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: '20260526' },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistPanel />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    expect(screen.getByText('SK하이닉스')).toBeInTheDocument();
  });

  it('clicking an entry sets activeCode in the store', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistPanel />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('삼성전자')).toBeInTheDocument());
    fireEvent.click(screen.getByText('삼성전자'));
    expect(useLivePageStore.getState().activeCode).toBe('005930');
  });

  it('shows empty message when no entries', async () => {
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({ entries: [], next_run_at_ms: 0 });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistPanel />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText(/관심종목이 없습니다/)).toBeInTheDocument());
  });

  it('highlights the active code', async () => {
    useLivePageStore.setState({ activeCode: '000660' } as any);
    vi.spyOn(watchlistApi, 'getWatchlist').mockResolvedValue({
      entries: [
        { code: '005930', name: '삼성전자', registered_at_kst_date: '20260101', last_success_date: null },
        { code: '000660', name: 'SK하이닉스', registered_at_kst_date: '20260101', last_success_date: null },
      ],
      next_run_at_ms: 0,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<WatchlistPanel />, { wrapper: wrap(qc) });
    await waitFor(() => expect(screen.getByText('SK하이닉스')).toBeInTheDocument());
    const activeRow = screen.getByTestId('watchlist-row-000660');
    expect(activeRow.getAttribute('aria-current')).toBe('true');
  });
});
