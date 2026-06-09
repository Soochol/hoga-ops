import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastDailyCandles, type LivePastDailyCandlesResponse } from './livePastDailyCandles';
import * as client from './client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE: LivePastDailyCandlesResponse = {
  code: '005930',
  from: '20240101',
  to: '20240105',
  candles: [{ t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 }],
  cached_batches: [],
  fresh_batches: ['20240101__20240105'],
  data_warnings: [],
};

describe('useLivePastDailyCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches daily bars for given code+from+to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastDailyCandles('005930', '20240101', '20240105'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-daily-candles?code=005930&from=20240101&to=20240105',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastDailyCandles(null, '20240101', '20240105'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fetch when from > to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastDailyCandles('005930', '20240105', '20240101'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  // Same regression as useLivePastCandles — see that test for the rationale.
  it('drops placeholder data when the code changes', async () => {
    const A = { ...RESPONSE, code: '005930' };
    const B = { ...RESPONSE, code: '000660' };
    vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('code=005930') ? A : B),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) =>
        useLivePastDailyCandles(code, '20240101', '20240105'),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ code: '000660' });
    expect(result.current.data?.code).not.toBe('005930');
    await waitFor(() => expect(result.current.data?.code).toBe('000660'));
  });
});
