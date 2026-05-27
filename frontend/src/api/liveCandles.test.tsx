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

  it('aggregates 1m candles into 5m buckets for the 5m timeframe', async () => {
    // Five 1m bars at 09:00, 09:01, ..., 09:04 KST. Server still receives
    // base='1m' — client aggregates into one 5m bar.
    const baseMs = 1779840000000; // 09:00:00 KST = 00:00:00 UTC
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      timeframe: '1m',
      candles: [
        { t_ms: baseMs + 0 * 60_000, open: 100, high: 105, low: 99, close: 102, volume: 10 },
        { t_ms: baseMs + 1 * 60_000, open: 102, high: 108, low: 101, close: 107, volume: 12 },
        { t_ms: baseMs + 2 * 60_000, open: 107, high: 110, low: 104, close: 105, volume: 8 },
        { t_ms: baseMs + 3 * 60_000, open: 105, high: 106, low: 100, close: 101, volume: 15 },
        { t_ms: baseMs + 4 * 60_000, open: 101, high: 103, low: 98, close: 99, volume: 5 },
      ],
      cached: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveCandles('005930', '5m'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.candles).toHaveLength(1));
    const bar = result.current.candles[0];
    expect(bar.open).toBe(100); // first 1m open
    expect(bar.high).toBe(110); // max across all 5 1m highs
    expect(bar.low).toBe(98);   // min across all 5 1m lows
    expect(bar.close).toBe(99); // last 1m close
    expect(bar.volume).toBe(50); // sum
    // The server query key is base='1m' even when display tf is '5m'.
    expect(spy).toHaveBeenCalledWith('/api/live/candles?code=005930&timeframe=1m');
  });

  it("passes 'W' through to the server without aggregation", async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      code: '005930',
      timeframe: 'W',
      candles: [{ t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 1000 }],
      cached: false,
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useLiveCandles('005930', 'W'), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith('/api/live/candles?code=005930&timeframe=W');
  });
});
