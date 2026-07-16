import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router';
import { MarketIndexBar } from './MarketIndexBar';
import { useLivePageStore } from '../state/livePage';
import * as client from '../api/client';

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

describe('MarketIndexBar', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useLivePageStore.setState({ activeInstrument: null, activeCode: null, candleTimeframe: '1m', historicalFromDate: null });
  });

  it('renders label + value + signed change with KRX direction colors', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      quotes: [
        KOSPI_WIRE,
        { id: 'KOSDAQ', label: 'KOSDAQ', value: 821.1, change: -3.2, change_rate: -0.39, t_ms: 1 },
      ],
    });

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
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ quotes: [] });

    renderBar();

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(screen.queryByTestId('market-index-bar')).not.toBeInTheDocument();
  });

  function mockByUrl(status: unknown) {
    vi.spyOn(client, 'apiCall').mockImplementation((url: string) => {
      if (url.includes('/status')) return Promise.resolve(status);
      return Promise.resolve({ quotes: [KOSPI_WIRE] });
    });
  }

  it('renders 실시간 coverage chip = KIS WS + 키움 WS when kiwoom present', async () => {
    mockByUrl({
      running: true, live_set: ['a', 'b', 'c'], capture_reason: 'ok',
      kiwoom: { enabled: true, accounts_configured: 2, connected_accounts: 2, subscribed_count: 40, last_tick_ms: null, accounts: [] },
    });
    renderBar();
    const chip = await screen.findByTestId('kiwoom-coverage-chip');
    expect(chip).toHaveTextContent('실시간');
    expect(chip).toHaveTextContent('43'); // 3 KIS WS + 40 키움 WS
  });

  it('paints coverage count with --warn when a kiwoom account is disconnected', async () => {
    mockByUrl({
      running: true, live_set: [], capture_reason: 'ok',
      kiwoom: { enabled: true, accounts_configured: 4, connected_accounts: 2, subscribed_count: 100, last_tick_ms: null, accounts: [] },
    });
    renderBar();
    const chip = await screen.findByTestId('kiwoom-coverage-chip');
    expect(chip.querySelector('.text-warn')).not.toBeNull();
  });

  it('hides coverage chip when kiwoom is absent (unwired)', async () => {
    mockByUrl({ running: true, live_set: ['a'], capture_reason: 'ok' });
    renderBar();
    await screen.findByTestId('market-index-bar');
    expect(screen.queryByTestId('kiwoom-coverage-chip')).not.toBeInTheDocument();
  });

  it('click opens the index in the current /live view and navigates', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ quotes: [KOSPI_WIRE] });
    const user = userEvent.setup();

    renderBar();

    await user.click(await screen.findByRole('button', { name: 'KOSPI 차트 열기' }));

    expect(screen.getByTestId('location-probe')).toHaveTextContent('/live');
    expect(useLivePageStore.getState().activeInstrument).toEqual({ kind: 'index', id: 'KOSPI', label: 'KOSPI' });
  });
});
