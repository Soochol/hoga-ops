import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useMarketIndexQuotes } from './marketIndexQuotes';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useMarketIndexQuotes', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('maps wire snake_case rows to camelCase quotes', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      quotes: [
        {
          id: 'KOSPI',
          label: 'KOSPI',
          value: 2855.67,
          change: 12.3,
          change_rate: 0.43,
          t_ms: 1_782_000_000_000,
        },
      ],
    });

    const { result } = renderHook(() => useMarketIndexQuotes(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.data).toEqual([
      {
        id: 'KOSPI',
        label: 'KOSPI',
        value: 2855.67,
        change: 12.3,
        changeRate: 0.43,
        tMs: 1_782_000_000_000,
      },
    ]));
    expect(spy).toHaveBeenCalledWith('/api/live/index-quotes', { signal: expect.any(AbortSignal) });
  });

  it('returns an empty list when the backend has no capacity/credentials', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({ quotes: [] });

    const { result } = renderHook(() => useMarketIndexQuotes(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.data).toEqual([]));
  });
});
