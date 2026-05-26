import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WatchlistPanel } from './WatchlistPanel';

// Mock the REST client.
vi.mock('../api/watchlist');
import * as api from '../api/watchlist';

// Mock SymbolSearch — keep the component test focused on Panel logic.
vi.mock('../capture/SymbolSearch', () => ({
  SymbolSearch: ({ onChange }: {
    value: unknown;
    onChange: (hit: { code: string; name: string; market?: string } | null) => void;
  }) => (
    <button
      type="button"
      data-testid="symbol-search-pick"
      onClick={() => onChange({ code: '003490', name: '대한항공', market: 'KOSPI' })}
    >
      pick 003490
    </button>
  ),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  vi.mocked(api.getWatchlist).mockReset();
  vi.mocked(api.addToWatchlist).mockReset();
  vi.mocked(api.removeFromWatchlist).mockReset();
});

describe('WatchlistPanel', () => {
  it('shows empty state when no entries', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [],
      next_run_at_ms: Date.now() + 3600_000,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() =>
      expect(screen.getByText(/자동 수집할 종목이 아직 없습니다/)).toBeInTheDocument());
  });

  it('shows count badge with N종목', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [
        { code: '003490', name: '대한항공',
          registered_at_kst_date: '20260520', last_success_date: '20260524' },
        { code: '005930', name: '삼성전자',
          registered_at_kst_date: '20260518', last_success_date: '20260524' },
      ],
      next_run_at_ms: Date.now() + 3600_000,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => expect(screen.getByText('2종목')).toBeInTheDocument());
  });

  it('lists entries when present', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValueOnce({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260526', last_success_date: null,
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => expect(screen.getByText('대한항공')).toBeInTheDocument());
  });

  it('after add succeeds, shows success banner with name+code', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.addToWatchlist).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() =>
      expect(screen.getByText(/대한항공.*003490.*추가됨/)).toBeInTheDocument());
  });

  it('success banner auto-dismisses after 5 seconds', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.addToWatchlist).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => screen.getByText(/추가됨/));
    // Banner auto-dismisses after JUST_ADDED_MS (5000ms). Use real timers and a
    // generous waitFor — fake timers can't capture the setTimeout already
    // scheduled in real time during the await above.
    await waitFor(
      () => expect(screen.queryByText(/추가됨/)).not.toBeInTheDocument(),
      { timeout: 7000 },
    );
  }, 10000);

  it('just-added row carries data-just-added attribute for 5 seconds', async () => {
    vi.mocked(api.getWatchlist)
      .mockResolvedValueOnce({  // initial fetch — empty
        entries: [],
        next_run_at_ms: Date.now() + 3600_000,
      })
      .mockResolvedValue({  // after invalidation — has the new entry
        entries: [{
          code: '003490', name: '대한항공',
          registered_at_kst_date: '20260526', last_success_date: null,
        }],
        next_run_at_ms: Date.now() + 3600_000,
      });
    vi.mocked(api.addToWatchlist).mockResolvedValueOnce({
      code: '003490', name: '대한항공',
      registered_at_kst_date: '20260526', last_success_date: null,
    });
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => {
      const row = screen.getByTestId('row-003490');
      expect(row).toHaveAttribute('data-just-added', 'true');
    });
  });

  it('calls removeFromWatchlist when the trash button is clicked', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [{
        code: '003490', name: '대한항공',
        registered_at_kst_date: '20260526', last_success_date: null,
      }],
      next_run_at_ms: Date.now() + 3600_000,
    });
    vi.mocked(api.removeFromWatchlist).mockResolvedValueOnce(undefined);
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByText('대한항공'));
    await userEvent.click(screen.getByLabelText(/Remove 대한항공/));
    await waitFor(() =>
      expect(api.removeFromWatchlist).toHaveBeenCalledWith('003490'));
  });

  it('shows error banner when add fails', async () => {
    vi.mocked(api.getWatchlist).mockResolvedValue({
      entries: [], next_run_at_ms: Date.now() + 3600_000,
    });
    const err = new Error('Code 003490 is already in the Watchlist.');
    vi.mocked(api.addToWatchlist).mockRejectedValueOnce(err);
    renderWithQuery(<WatchlistPanel />);
    await waitFor(() => screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByTestId('symbol-search-pick'));
    await userEvent.click(screen.getByRole('button', { name: /추가/ }));
    await waitFor(() => expect(screen.getByText(/already in the Watchlist/)).toBeInTheDocument());
  });
});
