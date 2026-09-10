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

it('keeps a newer WS observation when an in-flight REST poll completes', async () => {
  vi.restoreAllMocks();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['market-index-quotes'], [{
    id: 'KOSPI', label: 'KOSPI', value: 100, change: 0, changeRate: 0, tMs: 100,
  }], { updatedAt: 1 });
  let finish!: (value: unknown) => void;
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useMarketIndexQuotes(), { wrapper });
  await waitFor(() => expect(typeof finish).toBe('function'));
  expect(spy).toHaveBeenCalled();
  qc.setQueryData(['market-index-quotes'], [{
    id: 'KOSPI', label: 'KOSPI', value: 300, change: 3, changeRate: 1, tMs: 300,
  }]);
  finish({ quotes: [{ id: 'KOSPI', label: 'KOSPI', value: 200, change: 2, change_rate: 0.5, t_ms: 200 }] });
  await waitFor(() => expect(result.current.isFetching).toBe(false));
  expect(result.current.data?.[0]).toMatchObject({ value: 300, tMs: 300 });
  unmount();
  qc.clear();
});
