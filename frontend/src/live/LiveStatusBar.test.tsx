import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LiveStatusBar } from './LiveStatusBar';

const EMPTY_BUNDLE = {
  code: '005930',
  from_date: '20260527',
  to_date: '20260527',
  bucket_ms: 60_000,
  segments: [
    {
      date: '20260527',
      session_open_ms: 1748275200000,
      session_close_ms: 1748298600000,
      source: 'kis_live' as const,
    },
  ],
  candles: [] as Array<{
    ts_ms: number; open: number; close: number; high: number; low: number; vol_a: number; vol_b: number;
  }>,
  quote_ratio: { bucket_ms: 60_000, points: [] },
  fill_strength: { bucket_ms: 60_000, points: [] },
  volume_profile_range: { bin_count: 0, price_min: 0, price_max: 0, bin_width: 0, bins: [] },
  volume_profile_by_day: [],
};

vi.mock('./useLiveBundle', () => ({
  useLiveBundle: vi.fn(() => ({
    bundle: EMPTY_BUNDLE,
    isLoading: false,
    error: null,
    clampEngaged: false,
    isPastCandlesLoading: false,
  })),
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
    const { useLiveBundle } = await import('./useLiveBundle');
    (useLiveBundle as ReturnType<typeof vi.fn>).mockReturnValue({
      bundle: {
        ...EMPTY_BUNDLE,
        candles: [
          { ts_ms: 1000, open: 70000, high: 71000, low: 69000, close: 70500, vol_a: 1000, vol_b: 0 },
          { ts_ms: 2000, open: 70500, high: 72000, low: 70000, close: 71200, vol_a: 1500, vol_b: 0 },
        ],
      },
      isLoading: false,
      error: null,
      clampEngaged: false,
      isPastCandlesLoading: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode="005930" cycleLagMs={50} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('live-current-price').textContent).toContain('71,200');
  });

  it('renders the kis_live source chip (ADR-0039 compliance)', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <LiveStatusBar activeCode="005930" cycleLagMs={0} />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('source-chip-kis_live')).toBeTruthy();
  });
});
