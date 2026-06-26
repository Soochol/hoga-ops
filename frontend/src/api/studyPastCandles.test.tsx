import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as client from './client';
import { useStudyPastCandles, useStudyPastDailyCandles } from './studyPastCandles';
import type { LivePastCandlesResponse } from './livePastCandles';
import type { LivePastDailyCandlesResponse } from './livePastDailyCandles';

function wrap(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const minuteResponse: LivePastCandlesResponse = {
  code: '005930',
  from: '20260616',
  to: '20260618',
  venue: 'KRX',
  candles: [{ t_ms: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
  cached_dates: [],
  fresh_dates: [],
  data_warnings: [],
};

const dailyResponse: LivePastDailyCandlesResponse = {
  code: '005930',
  from: '20260616',
  to: '20260618',
  venue: 'KRX',
  candles: [{ t_ms: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
  cached_batches: [],
  fresh_batches: [],
  data_warnings: [],
};

describe('study past-candle queries', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches minute candles with static study freshness', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(minuteResponse);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useStudyPastCandles('005930', '20260616', '20260618', 'KRX'),
      { wrapper: wrap(qc) },
    );

    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));

    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-candles?code=005930&from=20260616&to=20260618&venue=KRX',
      { signal: expect.any(AbortSignal) },
    );
    const query = qc.getQueryCache().find({ queryKey: ['study', 'past-candles', '005930', '20260616', '20260618', 'KRX'] });
    const options = query?.options as { staleTime?: number; refetchInterval?: number | false } | undefined;
    expect(options?.staleTime).toBe(Infinity);
    expect(options?.refetchInterval).toBe(false);
  });

  it('fetches daily candles with static study freshness', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(dailyResponse);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useStudyPastDailyCandles('005930', '20260616', '20260618', 'KRX'),
      { wrapper: wrap(qc) },
    );

    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));

    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-daily-candles?code=005930&from=20260616&to=20260618&venue=KRX',
      { signal: expect.any(AbortSignal) },
    );
    const query = qc.getQueryCache().find({ queryKey: ['study', 'past-daily-candles', '005930', '20260616', '20260618', 'KRX'] });
    const options = query?.options as { staleTime?: number; refetchInterval?: number | false } | undefined;
    expect(options?.staleTime).toBe(Infinity);
    expect(options?.refetchInterval).toBe(false);
  });
});
