import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLiveIndexCandles, useLiveIndexInvestorNet, useLiveIndices } from './liveIndices';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

describe('useLiveIndices', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('maps representative index rows from the backend', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      indices: [
        { kind: 'index', id: 'KOSPI', label: 'KOSPI', investor_scope: 'market' },
        { kind: 'index', id: 'KOSPI200', label: 'KOSPI 200', investor_scope: 'none' },
      ],
    });

    const { result } = renderHook(() => useLiveIndices(), { wrapper: wrap() });

    await waitFor(() => expect(result.current.data?.[0]).toEqual({
      kind: 'index',
      id: 'KOSPI',
      label: 'KOSPI',
      investorScope: 'market',
    }));
    expect(result.current.data?.[1].investorScope).toBe('none');
    expect(spy).toHaveBeenCalledWith('/api/live/indices', { signal: expect.any(AbortSignal) });
  });

  it('fetches daily index candles for a representative index', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      index_id: 'KOSPI',
      from: '20260601',
      to: '20260619',
      timeframe: 'D',
      candles: [{ t_ms: 1, open: 2840.12, high: 2861.34, low: 2833.2, close: 2855.67, volume: 450000000 }],
      data_warnings: [],
    });

    const { result } = renderHook(
      () => useLiveIndexCandles('KOSPI', 'D', '20260601', '20260619'),
      { wrapper: wrap() },
    );

    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(result.current.data?.candles[0].close).toBe(2855.67);
    expect(spy).toHaveBeenCalledWith(
      '/api/live/index-candles?index_id=KOSPI&timeframe=D&from=20260601&to=20260619',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not fetch index candles until id and range are present', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ candles: [] });

    renderHook(
      () => useLiveIndexCandles(null, 'D', '20260601', '20260619'),
      { wrapper: wrap() },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches market investor net points for a representative index', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({
      index_id: 'KOSPI',
      from: '20260619',
      to: '20260619',
      points: [{ t_ms: 1, foreign_net: -3519, institution_net: 17184 }],
      data_warnings: [],
    });

    const { result } = renderHook(
      () => useLiveIndexInvestorNet('KOSPI', '20260619', '20260619', true),
      { wrapper: wrap() },
    );

    await waitFor(() => expect(result.current.data?.points).toHaveLength(1));
    expect(result.current.data?.points[0].foreign_net).toBe(-3519);
    expect(spy).toHaveBeenCalledWith(
      '/api/live/index-investor-net?index_id=KOSPI&from=20260619&to=20260619',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not fetch index investor net until explicitly enabled', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ points: [] });

    renderHook(
      () => useLiveIndexInvestorNet('KOSPI', '20260619', '20260619', false),
      { wrapper: wrap() },
    );

    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });
});
