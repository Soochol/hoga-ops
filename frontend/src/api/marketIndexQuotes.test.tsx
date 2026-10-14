import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager, onlineManager } from '@tanstack/react-query';
import { useMarketIndexQuotes } from './marketIndexQuotes';
import { applySectorTick } from './sectorTickOverlay';
import * as client from './client';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

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

it('polls KRX100 after thirty seconds even while WS ticks update the other indices', async () => {
  vi.restoreAllMocks();
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let calls = 0;
  const spy = vi.spyOn(client, 'apiCall').mockImplementation(async () => ({ quotes: [
    { id: 'KOSPI', label: 'KOSPI', value: 6000, change: 0, change_rate: 0, t_ms: Date.now() },
    { id: 'KRX100', label: 'KRX 100', value: 15000 + ++calls, change: 1, change_rate: 0.1, t_ms: Date.now() },
  ] }));
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useMarketIndexQuotes(), { wrapper });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(spy).toHaveBeenCalledTimes(1);
  for (let second = 0; second < 31; second++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      applySectorTick(qc, { type: 'market_sector_tick', sectors: {
        '001': { value: 6100 + second, t_ms: Date.now() },
      } });
    });
  }
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(spy).toHaveBeenCalledTimes(2);
  expect(result.current.data?.find(quote => quote.id === 'KRX100')?.value).toBe(15002);
  expect(result.current.data?.find(quote => quote.id === 'KOSPI')?.value).toBe(6130);
  unmount();
  qc.clear();
});

it('refreshes when returning to the tab or reconnecting despite global refetch defaults being off', async () => {
  vi.restoreAllMocks();
  focusManager.setFocused(false);
  const qc = new QueryClient({ defaultOptions: { queries: {
    retry: false, refetchOnWindowFocus: false, refetchOnReconnect: false,
  } } });
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ quotes: [
    { id: 'KRX100', label: 'KRX 100', value: 15000, change: 1, change_rate: 0.1, t_ms: Date.now() },
  ] });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useMarketIndexQuotes(), { wrapper });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  const now = Date.now();
  vi.spyOn(Date, 'now').mockReturnValue(now + 60_000);
  await act(async () => { focusManager.setFocused(true); });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  vi.spyOn(Date, 'now').mockReturnValue(now + 120_000);
  await act(async () => { onlineManager.setOnline(false); onlineManager.setOnline(true); });
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(3));
  unmount();
  qc.clear();
});
