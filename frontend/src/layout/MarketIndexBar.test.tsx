import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { MarketIndexBar } from './MarketIndexBar';
import { useLivePageStore } from '../state/livePage';
import * as client from '../api/client';
import type { FlowCollection } from '../api/market';
import type { InvestorFlowSummaryResponse } from '../api/marketInvestorFlowSummary';

function LocationProbe() {
  const { pathname } = useLocation();
  return <div data-testid="location-probe">{pathname}</div>;
}

function renderBar() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/heatmap']}>
        <MarketIndexBar />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const KOSPI_WIRE = {
  id: 'KOSPI',
  label: 'KOSPI',
  value: 2855.67,
  change: 12.3,
  change_rate: 0.43,
  t_ms: 1_782_000_000_000,
};

function flowSummary(withPoints = false): InvestorFlowSummaryResponse {
  const now = Date.now();
  const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul' }).format(now).replaceAll('-', '');
  const collection: FlowCollection = {
    server_now_ms: now, collection_expected: true, poll_interval_ms: 10_000,
    stale_after_ms: 30_000,
    targets: Object.fromEntries(['KOSPI', 'KOSDAQ', 'F001'].map((key) => [key, {
      status: 'receiving', last_attempt_at_ms: now, last_success_at_ms: now,
      last_written_at_ms: now, consecutive_failures: 0, error_kind: null,
      failure_started_at_ms: null, gaps: [],
    }])),
  };
  return {
    stock: { date, unit: 'amt_eok', confirmed: false, collection, markets: {
      KOSPI: withPoints ? { t_ms: now, individual: -3240, foreign: 2180, institution: 980 } : null,
      KOSDAQ: withPoints ? { t_ms: now, individual: 1120, foreign: -860, institution: 0 } : null,
    } },
    futures: { date, unit: 'amt_eok', confirmed: false, collection, markets: {
      F001: withPoints ? { t_ms: now, individual: -820, foreign: 1350, institution: -470 } : null,
    } },
  };
}

function mockMarketData(quotes: unknown[], summary = flowSummary(), status: unknown = {}) {
  return vi.spyOn(client, 'apiCall').mockImplementation((url: string) => {
    if (url.includes('/investor-flow-summary')) return Promise.resolve(summary);
    if (url.includes('/status')) return Promise.resolve(status);
    return Promise.resolve({ quotes });
  });
}

afterEach(() => vi.useRealTimers());

describe('MarketIndexBar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
  });

  it('renders label + value + signed change with KRX direction colors', async () => {
    mockMarketData([
        KOSPI_WIRE,
        { id: 'KOSDAQ', label: 'KOSDAQ', value: 821.1, change: -3.2, change_rate: -0.39, t_ms: 1 },
      ]);

    renderBar();

    const bar = await screen.findByTestId('market-index-bar');
    expect(bar).toBeInTheDocument();
    expect(screen.getByText('KOSPI')).toBeInTheDocument();
    expect(screen.getByText('2,855.67')).toBeInTheDocument();
    // 상승 = price-up(빨강) + '+' 부호, 하락 = price-down(파랑) — 색+부호 2중.
    expect(screen.getByText('+12.30 (+0.43%)')).toHaveClass('text-price-up');
    expect(screen.getByText('-3.20 (-0.39%)')).toHaveClass('text-price-down');
  });

  it('renders nothing when the backend returns no quotes', async () => {
    const spy = mockMarketData([]);

    renderBar();

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('market-index-bar')).not.toBeInTheDocument();
  });

  function mockByUrl(status: unknown) {
    mockMarketData([KOSPI_WIRE], flowSummary(), status);
  }

  it('renders Kiwoom coverage without double counting the same live_set', async () => {
    mockByUrl({
      running: true, live_set: ['a', 'b', 'c'], capture_reason: 'healthy',
      kiwoom: { enabled: true, accounts_configured: 2, connected_accounts: 2, subscribed_count: 40, last_tick_ms: null, accounts: [] },
    });
    renderBar();
    const chip = await screen.findByTestId('kiwoom-coverage-chip');
    expect(chip).toHaveTextContent('실시간');
    expect(chip).toHaveTextContent('40'); // legacy fallback: storage count only
  });

  it('paints coverage count with --warn when a kiwoom account is disconnected', async () => {
    mockByUrl({
      running: true, live_set: [], capture_reason: 'healthy',
      kiwoom: { enabled: true, accounts_configured: 4, connected_accounts: 2, subscribed_count: 100, last_tick_ms: null, accounts: [] },
    });
    renderBar();
    const chip = await screen.findByTestId('kiwoom-coverage-chip');
    expect(chip.querySelector('.text-warn')).not.toBeNull();
  });

  it('hides coverage chip when kiwoom is absent (unwired)', async () => {
    mockByUrl({ running: true, live_set: ['a'], capture_reason: 'healthy' });
    renderBar();
    await screen.findByTestId('market-index-bar');
    expect(screen.queryByTestId('kiwoom-coverage-chip')).not.toBeInTheDocument();
  });

  it('click opens the index in the current /live view and navigates', async () => {
    mockMarketData([KOSPI_WIRE], flowSummary(true));
    const user = userEvent.setup();

    renderBar();

    await user.click(await screen.findByRole('button', { name: 'KOSPI 차트 열기' }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/live');
    expect(useLivePageStore.getState().activeInstrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
    expect(screen.getByTestId('market-index-bar')).toHaveAttribute('data-page', 'indices');
  });

  it('switches on empty area clicks, while data and coverage clicks keep the current page', async () => {
    mockMarketData([KOSPI_WIRE], flowSummary(true), {
      kiwoom: { connected_accounts: 1, accounts_configured: 1, subscribed_count: 330 },
    });
    renderBar();
    const user = userEvent.setup();
    await screen.findByRole('button', { name: '투자자 수급 화면으로 전환' });
    const bar = screen.getByTestId('market-index-bar');
    await user.click(bar);
    expect(bar).toHaveAttribute('data-page', 'flow');
    expect(screen.getByTestId('market-flow-KOSPI')).toHaveTextContent('외인+2,180기관+980개인-3,240');
    expect(screen.getByTestId('market-flow-KOSDAQ')).toHaveTextContent('기관0');
    expect(screen.getByTestId('market-flow-F001')).toHaveTextContent('K200 선물');
    expect(within(screen.getByTestId('market-flow-KOSPI')).getByText('-3,240')).toHaveClass('text-price-down');
    await user.click(screen.getByText('+2,180'));
    await user.click(screen.getByTestId('kiwoom-coverage-chip'));
    expect(bar).toHaveAttribute('data-page', 'flow');
    await user.click(screen.getByRole('button', { name: '지수 화면으로 전환' }));
    expect(bar).toHaveAttribute('data-page', 'indices');
    expect(screen.getByTestId('kiwoom-coverage-chip')).toHaveTextContent('330');
  });

  it('rotates every ten seconds and restarts the countdown after a manual switch', async () => {
    vi.useFakeTimers();
    mockMarketData([KOSPI_WIRE], flowSummary(true));
    renderBar();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const bar = screen.getByTestId('market-index-bar');
    expect(bar).toHaveAttribute('data-page', 'indices');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(bar).toHaveAttribute('data-page', 'flow');
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(bar).toHaveAttribute('data-page', 'indices');
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    fireEvent.click(bar);
    expect(bar).toHaveAttribute('data-page', 'flow');
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(bar).toHaveAttribute('data-page', 'flow');
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(bar).toHaveAttribute('data-page', 'indices');
  });

  it('does not rotate to an empty flow page and supports a flow-only bar', async () => {
    mockMarketData([KOSPI_WIRE]);
    const mounted = renderBar();
    await screen.findByTestId('market-index-bar');
    expect(screen.queryByTestId('market-bar-switch')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('market-index-bar'));
    expect(screen.getByTestId('market-index-bar')).toHaveAttribute('data-page', 'indices');
    mounted.unmount();
    mockMarketData([], flowSummary(true));
    renderBar();
    expect(await screen.findByTestId('market-flow-KOSPI')).toBeInTheDocument();
    expect(screen.getByTestId('market-index-bar')).toHaveAttribute('data-page', 'flow');
    expect(screen.queryByTestId('market-bar-switch')).not.toBeInTheDocument();
  });

  it('shows receipt delays and does not label unresolved futures quantities as money', async () => {
    const summary = flowSummary(true);
    summary.futures.unit = null;
    summary.stock.collection!.targets.KOSPI.last_success_at_ms = Date.now() - 60_000;
    mockMarketData([KOSPI_WIRE], summary);
    renderBar();
    await screen.findByTestId('market-bar-switch');
    fireEvent.click(screen.getByTestId('market-index-bar'));
    expect(screen.getByTestId('market-flow-KOSPI')).toHaveTextContent('수신 지연');
    expect(screen.getByTestId('market-flow-F001')).toHaveTextContent('단위 확인 중');
    expect(within(screen.getByTestId('market-flow-F001')).getAllByText('—')).toHaveLength(3);
    expect(screen.queryByText('+1,350')).not.toBeInTheDocument();
  });
});

it('shows the age and timestamp of an old quote without treating it as a connection failure', async () => {
  mockMarketData([{ ...KOSPI_WIRE, t_ms: Date.now() - 180_000 }]);
  renderBar();
  expect(await screen.findByText('시세 3분 전')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'KOSPI 차트 열기' }).title).toContain('시세 기준');
});
