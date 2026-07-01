import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Settings from './Settings';
import * as symbolsApi from '../api/symbols';
import * as signalAlertsApi from '../api/signalAlerts';

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

  it('renders signal alert settings defaults', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });

    renderWithQuery(<Settings />);

    expect(await screen.findByText('시그널 알림')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: '알림 사용' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('기준 시각')).toHaveValue('11:00');
    expect(screen.getByLabelText('기준 시각')).toHaveAttribute('min', '09:00');
    expect(screen.getByLabelText('기준 시각')).toHaveAttribute('max', '15:20');
    expect(screen.getByLabelText('기준 최대값 대비 문턱 (%)')).toHaveValue(100);
    expect(screen.getByLabelText('기준 최대값 대비 문턱 (%)')).toHaveAttribute('min', '50');
    expect(screen.getByLabelText('기준 최대값 대비 문턱 (%)')).toHaveAttribute('max', '150');
    expect(screen.getByRole('switch', { name: '분봉 내 최대 매도 총잔량으로 판정' })).toHaveAttribute('aria-checked', 'true');
  });

  it('saves changed signal alert settings values', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
    const mutate = vi.fn();
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    renderWithQuery(<Settings />);

    const enabled = await screen.findByRole('switch', { name: '알림 사용' });
    const startTime = screen.getByLabelText('기준 시각');
    const threshold = screen.getByLabelText('기준 최대값 대비 문턱 (%)');
    const intraMinuteMax = screen.getByRole('switch', { name: '분봉 내 최대 매도 총잔량으로 판정' });

    fireEvent.click(enabled);
    fireEvent.change(startTime, { target: { value: '11:15' } });
    fireEvent.blur(startTime);
    fireEvent.change(threshold, { target: { value: '95' } });
    fireEvent.blur(threshold);
    fireEvent.click(intraMinuteMax);

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith({
        sell_total_renewal: {
          enabled: false,
          start_hhmm: 1115,
          threshold_pct: 95,
          use_intra_minute_max: false,
        },
      });
    });
  });

  it('rejects invalid signal alert start times and restores the saved draft', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
    const mutate = vi.fn();
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    renderWithQuery(<Settings />);

    const startTime = await screen.findByLabelText('기준 시각');
    fireEvent.change(startTime, { target: { value: '08:59' } });
    fireEvent.blur(startTime);

    await waitFor(() => {
      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('기준 시각')).toHaveValue('11:00');
    });
  });

  it('rejects invalid signal alert thresholds and restores the saved draft', async () => {
    vi.spyOn(symbolsApi, 'getSymbolMasterInfo').mockResolvedValue({
      count: 0,
      fetched_at_ms: null,
      status: 'fresh',
      reason: null,
    });
    vi.spyOn(signalAlertsApi, 'getSignalAlertSettings').mockResolvedValue({
      schema_version: 1,
      sell_total_renewal: {
        enabled: true,
        start_hhmm: 1100,
        threshold_pct: 100,
        use_intra_minute_max: true,
      },
    });
    const mutate = vi.fn();
    vi.spyOn(signalAlertsApi, 'usePatchSignalAlertSettings').mockReturnValue({
      mutate,
      mutateAsync: vi.fn(),
      reset: vi.fn(),
      status: 'idle',
      isIdle: true,
      isPending: false,
      isSuccess: false,
      isError: false,
      isPaused: false,
      failureCount: 0,
      failureReason: null,
      submittedAt: 0,
      variables: undefined,
      data: undefined,
      error: null,
      context: undefined,
    } as never);

    renderWithQuery(<Settings />);

    const threshold = await screen.findByLabelText('기준 최대값 대비 문턱 (%)');
    fireEvent.change(threshold, { target: { value: '49' } });
    fireEvent.blur(threshold);

    await waitFor(() => {
      expect(mutate).not.toHaveBeenCalled();
      expect(screen.getByLabelText('기준 최대값 대비 문턱 (%)')).toHaveValue(100);
    });
  });
});
