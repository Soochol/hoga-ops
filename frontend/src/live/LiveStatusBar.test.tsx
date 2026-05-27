import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveStatusBar } from './LiveStatusBar';

vi.mock('../api/liveCandles', () => ({
  useLiveCandles: vi.fn(() => ({ data: undefined, isLoading: true })),
}));

describe('LiveStatusBar', () => {
  beforeEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows em-dash when activeCode is null', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode={null} cycleLagMs={0} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-status-bar').textContent).toContain('—');
  });

  it('shows the activeCode when set', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode="005930" cycleLagMs={0} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-status-bar').textContent).toContain('005930');
  });

  it('shows 대기 중 price placeholder when candle data is not yet available', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode="005930" cycleLagMs={100} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-status-bar').textContent).toContain('대기 중');
  });

  it('shows latest candle close price when data is available', async () => {
    const { useLiveCandles } = await import('../api/liveCandles');
    (useLiveCandles as ReturnType<typeof vi.fn>).mockReturnValue({
      data: {
        code: '005930',
        timeframe: '1m',
        candles: [
          { t_ms: 1000, open: 70000, high: 71000, low: 69000, close: 70500, volume: 1000 },
          { t_ms: 2000, open: 70500, high: 72000, low: 70000, close: 71200, volume: 1500 },
        ],
        cached: false,
      },
      isLoading: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode="005930" cycleLagMs={50} />
      </QueryClientProvider>,
    );
    // Latest close is 71200
    expect(screen.getByTestId('live-current-price').textContent).toContain('71,200');
  });
});
