import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Capture from './Capture';
import type { ReactNode } from 'react';
import { stockInstrument } from '../live/liveInstrument';
import { useLivePageStore } from '../state/livePage';

vi.mock('../api/eventStream', () => ({
  subscribeToCaptureEvents: () => () => {},
}));

function W(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  useLivePageStore.setState({ activeInstrument: null, activeCode: null });
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url: RequestInfo | URL) => {
    const s = String(url);
    if (s.includes('/api/symbols/all')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          symbols: [
            {
              code: '005930',
              name: '삼성전자',
              market: 'KOSPI',
              captured_count: 0,
              captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
            },
          ],
          status: 'fresh',
          fetched_at_ms: 1,
        }),
      } as Response;
    }
    if (s.includes('/api/captures/queue')) return { ok: true, status: 200, json: async () => ({ active: [], queued: [], done: [], paused: false, max_concurrent: 3 }) } as Response;
    if (s.includes('/api/stock-dates')) return { ok: true, status: 200, json: async () => [] } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
});

describe('Capture page', () => {
  it('renders both the form panel (left) and the queue panel (right)', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));
    // 부유 카드 모델(2026-07-15): borderless — --bg-card + shadow-panel 만으로 분리.
    expect(screen.getByTestId('capture-form-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('capture-form-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-form-pane')).toHaveClass('shadow-panel');
    expect(screen.getByTestId('capture-queue-pane')).toHaveClass('bg-bg-card');
    expect(screen.getByTestId('capture-queue-pane')).not.toHaveClass('border');
    expect(screen.getByTestId('capture-queue-pane')).toHaveClass('shadow-panel');
    expect(screen.getByPlaceholderText(/종목/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Start/i })).toBeTruthy();
    // Queue side hidden by empty-state when no rows. Check that empty state
    // marker renders — this confirms CaptureQueue mounted on the right.
    expect(screen.getByTestId('queue-empty')).toBeTruthy();
    expect(screen.getByPlaceholderText(/종목/i).closest('.bg-bg-card')).not.toBeNull();
    expect(screen.getByTestId('queue-empty').closest('.bg-bg-card')).not.toBeNull();
  });

  it('lets the queue section shrink inside the fixed capture viewport', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<Capture />, { wrapper: W(qc) });
    await new Promise((r) => setTimeout(r, 30));

    const queueSection = screen.getByRole('region', { name: '캡처 대기열' });
    expect(queueSection).toHaveClass('min-h-0');
  });

  it('prefills the symbol from the active live stock when capture has no code query', async () => {
    useLivePageStore.setState({
      activeInstrument: stockInstrument('005930', '삼성전자'),
      activeCode: '005930',
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(<Capture />, { wrapper: W(qc) });

    await new Promise((r) => setTimeout(r, 30));
    expect((screen.getByPlaceholderText(/종목/i) as HTMLInputElement).value).toContain('삼성전자');
  });
});
