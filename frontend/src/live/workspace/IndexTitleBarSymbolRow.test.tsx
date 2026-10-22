import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from '../../api/client';
import { indexHeaderQuoteKey, type IndexHeaderQuoteResponse } from '../../api/indexHeaderQuote';
import { TitleBarSymbolRow } from './TitleBarSymbolRow';

const NOW = new Date('2026-10-22T10:00:00+09:00').getTime();
const quote = (overrides: Partial<IndexHeaderQuoteResponse> = {}): IndexHeaderQuoteResponse => ({
  index_id: 'KOSPI', value: 2650.35, change: 32.46, change_rate: 1.24, previous_close: 2617.89,
  trading_date: '20261022', observed_at_ms: NOW, checked_at_ms: NOW, market_timezone: 'Asia/Seoul',
  session_status: 'open', refresh_status: 'normal', source: 'kiwoom', delay_unverified: false, ...overrides,
});

function setup(data?: IndexHeaderQuoteResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (data) qc.setQueryData(indexHeaderQuoteKey('KOSPI'), data);
  const row = (code: string, name = code) => <QueryClientProvider client={qc}>
    <TitleBarSymbolRow name={name} code={code} isIndex windowId="index-w1" />
  </QueryClientProvider>;
  return { qc, row, ...render(row('KOSPI')) };
}

describe('index chart header', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    vi.spyOn(client, 'apiCall').mockResolvedValue(quote());
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('shows fractional points and signed percent without header tooltips', () => {
    setup(quote());
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('2,650.35');
    expect(screen.getByTestId('titlebar-change')).toHaveTextContent('+1.24%');
    expect(screen.getByTestId('titlebar-current-price')).toHaveAttribute('data-direction', 'up');
    const price = screen.getByTestId('titlebar-current-price');
    expect(price).toHaveAttribute('tabindex', '0');
    expect(screen.getByTestId('titlebar-symbol-row').querySelectorAll('[title]')).toHaveLength(0);
    expect(screen.queryByTestId('titlebar-index-status')).toBeNull();
  });

  it.each([-1.24, 0])('formats down/flat rates without inventing an upward sign (%s)', pct => {
    setup(quote({ change_rate: pct }));
    expect(screen.getByTestId('titlebar-change')).toHaveTextContent(`${pct.toFixed(2)}%`);
    expect(screen.getByTestId('titlebar-change')).not.toHaveTextContent('+');
  });

  it('keeps the closed-session value without a hover tooltip', () => {
    setup(quote({ trading_date: '20261021', session_status: 'closed' }));
    expect(screen.getByTestId('titlebar-index-status')).toHaveTextContent('장 종료');
    expect(screen.getByTestId('titlebar-current-price')).not.toHaveAttribute('title');
  });

  it('clears the previous index while the replacement request is pending, ignoring a late old response', async () => {
    const finish: Record<string, (data: IndexHeaderQuoteResponse) => void> = {};
    vi.mocked(client.apiCall).mockImplementation(path => new Promise(resolve => {
      finish[path] = resolve as (data: IndexHeaderQuoteResponse) => void;
    }));
    const view = setup(quote());
    view.rerender(view.row('KOSDAQ'));
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('—');
    await waitFor(() => expect(finish['/api/live/index-header-quote?index_id=KOSDAQ']).toBeTypeOf('function'));
    await act(async () => finish['/api/live/index-header-quote?index_id=KOSDAQ'](quote({ index_id: 'KOSDAQ', value: 850.12 })));
    await waitFor(() => expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('850.12'));
    act(() => view.qc.setQueryData(indexHeaderQuoteKey('KOSPI'), quote({ value: 9999 })));
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('850.12');
  });

  it('keeps last-good values on failure and retries', async () => {
    const view = setup(quote({ refresh_status: 'stale' }));
    const button = screen.getByRole('button', { name: 'KOSPI 시세 다시 조회' });
    expect(button).toHaveTextContent('조회 지연');
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('2,650.35');
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    await waitFor(() => expect(client.apiCall).toHaveBeenCalledWith(
      '/api/live/index-header-quote?index_id=KOSPI&retry=true', { signal: expect.any(AbortSignal) }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'KOSPI 시세 다시 조회' })).toBeNull());
    expect(view.qc.getQueryData(indexHeaderQuoteKey('KOSPI'))).toMatchObject({ refresh_status: 'normal' });
  });

  it('shows an initial network failure with a retry and no fabricated price', async () => {
    vi.mocked(client.apiCall).mockRejectedValue(new Error('offline'));
    setup();
    await waitFor(() => expect(screen.getByRole('button', { name: 'KOSPI 시세 다시 조회' })).toHaveTextContent('조회 실패'));
    expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('—');
  });

  it('keeps the last US price while accepting a slower server retry interval', async () => {
    const view = setup();
    act(() => view.qc.setQueryData(indexHeaderQuoteKey('SP500'), quote({ index_id: 'SP500',
      refresh_status: 'stale', refresh_interval_ms: 2000 })));
    vi.mocked(client.apiCall).mockResolvedValue(quote({ index_id: 'SP500', value: null,
      refresh_status: 'error', refresh_interval_ms: 60_000 }));
    view.rerender(view.row('SP500'));
    fireEvent.click(screen.getByRole('button', { name: 'SP500 시세 다시 조회' }));
    await waitFor(() => expect(view.qc.getQueryData(indexHeaderQuoteKey('SP500')))
      .toMatchObject({ value: 2650.35, refresh_status: 'error', refresh_interval_ms: 60_000 }));
  });

  it('keeps a verified same-day baseline on refresh failure but never carries it across a trading date', async () => {
    const view = setup(quote({ refresh_status: 'stale' }));
    vi.mocked(client.apiCall).mockResolvedValue(quote({ refresh_status: 'partial', previous_close: null,
      change: null, change_rate: null }));
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI 시세 다시 조회' }));
    await waitFor(() => expect(view.qc.getQueryData(indexHeaderQuoteKey('KOSPI')))
      .toMatchObject({ previous_close: 2617.89, refresh_status: 'partial' }));
    expect(screen.getByTestId('titlebar-change')).not.toHaveTextContent('—');
    vi.mocked(client.apiCall).mockResolvedValue(quote({ refresh_status: 'partial', previous_close: null,
      trading_date: '20261023', change: null, change_rate: null }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'KOSPI 시세 다시 조회' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'KOSPI 시세 다시 조회' }));
    await waitFor(() => expect(screen.getByTestId('titlebar-change')).toHaveTextContent('—'));
  });

  it('uses a newer domestic WS snapshot as a coherent value, percent and previous close', async () => {
    const { qc } = setup(quote());
    act(() => qc.setQueryData(['market-index-quotes'], [{ id: 'KOSPI', label: 'KOSPI', value: 2700.25,
      change: 100, changeRate: 3.85, tMs: NOW + 1000 }]));
    await waitFor(() => expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('2,700.25'));
    expect(screen.getByTestId('titlebar-change')).toHaveTextContent('+3.85%');
    expect(screen.getByTestId('titlebar-current-price')).not.toHaveAttribute('title');
  });

  it('keeps US index quotes and closed status without header tooltips', async () => {
    vi.mocked(client.apiCall).mockResolvedValue(quote({ index_id: 'SP500', source: 'kis_minute', delay_unverified: true,
      market_timezone: 'America/New_York', trading_date: '20261021', session_status: 'closed' }));
    const view = setup();
    view.rerender(view.row('SP500', 'S&P 500'));
    await waitFor(() => expect(screen.getByTestId('titlebar-current-price')).toHaveTextContent('2,650.35'));
    expect(screen.getByTestId('titlebar-symbol-row').querySelectorAll('[title]')).toHaveLength(0);
    expect(screen.getByTestId('titlebar-index-status')).toHaveTextContent('장 종료');
  });
});
