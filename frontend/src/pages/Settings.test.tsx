import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import * as symbolsApi from '../api/symbols';
import { useThemePrefsStore } from '../state/themePrefs';

vi.mock('../config', () => ({
  loadConfig: () => Promise.resolve({ api_url: 'http://test' }),
}));

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe('Settings — Symbol Master section', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders unavailable state with hint', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'unavailable',
      reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.getByText('0')).toBeInTheDocument(); // count
    expect(screen.getByText(/아직 다운로드되지 않았습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders fresh state', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: Date.now() - 3600_000, // 1 hour ago
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('fresh')).toBeInTheDocument();
  });

  it('clicking Update Now calls refreshSymbols and invalidates', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
    const refreshSpy = vi
      .spyOn(symbolsApi, 'refreshSymbols')
      .mockResolvedValue({ symbols: [], status: 'fresh', fetched_at_ms: Date.now(), reason: null });

    renderWithQuery(<Settings />);
    const btn = await screen.findByRole('button', { name: /Update Now/i });
    btn.click();

    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledOnce();
    });
  });

  it('renders loading state (Update in flight): button label still shows Update Now (local updating drives label change)', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'loading',
      reason: null,
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('loading')).toBeInTheDocument();
    });
    // Wire status='loading' does NOT auto-disable the button — local updating state does.
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('renders stale state: cache preserved, reason hint visible, button still actionable', async () => {
    const TWO_HOURS_AGO = Date.now() - 2 * 60 * 60 * 1000;
    // kis_master_fetch_failed is the only fetch-failure reason the symbols
    // backend actually emits on this surface — the previous mock used
    // kis_holiday_fetch_failed, an impossible state here, so the reachable
    // hint copy went untested.
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 6012,
      fetched_at_ms: TWO_HOURS_AGO,
      status: 'stale',
      reason: 'kis_master_fetch_failed',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText('6,012')).toBeInTheDocument();
    });
    expect(screen.getByText('stale')).toBeInTheDocument();
    expect(screen.getByText(/KIS 종목 마스터.*다운로드에 실패/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Update Now/i })).toBeEnabled();
  });

  it('does not render force retry capture defaults', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.queryByTestId('settings-force-retry-default')).toBeNull();
    expect(screen.queryByText(/force/i)).toBeNull();
  });

  it('uses the feature page shell without repeating the nav page title', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'unavailable',
      reason: 'symbol_master_not_initialized',
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('heading', { name: 'Settings' })).toBeNull();
    expect(screen.getByTestId('settings-page-primary')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('settings-page-primary')).toHaveClass('border');
  });

  it('does not render signal alert settings after moving them to the live settings modal', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });

    renderWithQuery(<Settings />);

    await waitFor(() => {
      expect(screen.getByText(/Symbol Master/i)).toBeInTheDocument();
    });
    expect(screen.queryByText('시그널 알림')).toBeNull();
    expect(screen.queryByRole('switch', { name: '알림 사용' })).toBeNull();
  });
});

describe('Settings — 테마 section', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    useThemePrefsStore.setState({ themePreference: 'auto' });
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0, fetched_at_ms: null, status: 'unavailable', reason: 'symbol_master_not_initialized',
    });
  });

  it('renders the three theme options with auto pressed by default', async () => {
    renderWithQuery(<Settings />);
    await waitFor(() => expect(screen.getByText('테마')).toBeInTheDocument());
    const auto = screen.getByRole('button', { name: '자동' });
    expect(auto).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Obsidian' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Ledger' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking Ledger updates the store and aria-pressed', async () => {
    renderWithQuery(<Settings />);
    const ledger = await screen.findByRole('button', { name: 'Ledger' });
    ledger.click();
    await waitFor(() => {
      expect(useThemePrefsStore.getState().themePreference).toBe('ledger');
    });
    expect(ledger).toHaveAttribute('aria-pressed', 'true');
  });
});
