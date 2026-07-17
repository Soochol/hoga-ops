import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveStatus } from './liveStatus';
import * as client from './client';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveStatus', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches /api/live/status and returns it', async () => {
    const fake = {
      running: true,
      started_at_ms: 1_000_000,
      last_tick_ms: 1_000_500,
      cycle_lag_ms: 200,
      capture_healthy: true,
      capture_reason: 'healthy',
      watchlist_count: 3,
      kis_calls_today: 12,
      kis_rate_limit_remaining: null,
      kis_rest_bypass_enabled: false,
    };
    vi.spyOn(client, 'apiCall').mockResolvedValue(fake);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveStatus(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data).toEqual(fake));
    expect(client.apiCall).toHaveBeenCalledWith('/api/live/status');
  });

  it('includes live_set field in LiveStatus response', async () => {
    const fake = {
      running: true, started_at_ms: 1_000_000, last_tick_ms: 1_000_500,
      cycle_lag_ms: 200, capture_healthy: true, capture_reason: 'healthy',
      watchlist_count: 3, kis_calls_today: 12, kis_rate_limit_remaining: null,
      live_set: ['005930', '000660'],
    };
    vi.spyOn(client, 'apiCall').mockResolvedValue(fake);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveStatus(), { wrapper: wrapper(qc) });
    await waitFor(() => expect(result.current.data?.live_set).toEqual(['005930', '000660']));
  });

  it('exposes loading state before first fetch resolves', async () => {
    let resolve: ((v: unknown) => void) | null = null;
    vi.spyOn(client, 'apiCall').mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveStatus(), { wrapper: wrapper(qc) });
    expect(result.current.isLoading).toBe(true);
    resolve!({
      running: false, started_at_ms: null, last_tick_ms: null,
      cycle_lag_ms: 0, capture_healthy: false, capture_reason: 'offline',
      watchlist_count: 0, kis_calls_today: 0, kis_rate_limit_remaining: null,
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
  });
});
