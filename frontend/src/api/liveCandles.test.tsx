import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveCandles } from './liveCandles';
import * as client from './client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches candles for the given code+timeframe', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      timeframe: '1m',
      candles: [{ t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
      cached: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveCandles('005930', '1m'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith('/api/live/candles?code=005930&timeframe=1m');
  });

  it('does not fetch when code is empty', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({} as any);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLiveCandles('', '1m'), { wrapper: wrap(qc) });
    // Wait long enough for the query to fire if it would.
    await new Promise((r) => setTimeout(r, 50));
    expect(spy).not.toHaveBeenCalled();
  });
});
