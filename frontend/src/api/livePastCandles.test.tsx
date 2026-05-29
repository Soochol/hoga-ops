import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useLivePastCandles, type LivePastCandlesResponse } from './livePastCandles';
import * as client from './client';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

const RESPONSE: LivePastCandlesResponse = {
  code: '005930',
  from: '20260501',
  to: '20260502',
  candles: [
    { t_ms: 1, open: 100, high: 110, low: 95, close: 105, volume: 10 },
  ],
  cached_dates: [],
  fresh_dates: ['20260501', '20260502'],
  data_warnings: [],
};

describe('useLivePastCandles', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches candles for given code+from+to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => useLivePastCandles('005930', '20260501', '20260502'),
      { wrapper: wrap(qc) },
    );
    await waitFor(() => expect(result.current.data?.candles).toHaveLength(1));
    expect(spy).toHaveBeenCalledWith('/api/live/past-candles?code=005930&from=20260501&to=20260502');
  });

  it('does not fetch when code is null', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles(null, '20260501', '20260502'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fetch when from > to', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260510', '20260501'), { wrapper: wrap(qc) });
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });

  it('queryKey changes split cache entries', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ to }: { to: string }) => useLivePastCandles('005930', '20260501', to),
      { wrapper: wrap(qc), initialProps: { to: '20260502' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ to: '20260503' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  // Regression: code-aware placeholderData prevents the previous code's
  // candle count from leaking through during a watchlist switch. Without
  // this, LiveChartRoot's initial-view effect would lock setVisibleLogicalRange
  // to the stale right edge and push the new code's latest candle off-screen.
  it('drops placeholder data when the code changes', async () => {
    const RESPONSE_005930 = { ...RESPONSE, code: '005930' };
    const RESPONSE_000660 = { ...RESPONSE, code: '000660' };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('code=005930') ? RESPONSE_005930 : RESPONSE_000660),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ code }: { code: string }) =>
        useLivePastCandles(code, '20260501', '20260502'),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ code: '000660' });
    // Right after switching codes the placeholder must NOT be the previous
    // code's data — either undefined (loading) or already the new code's data.
    expect(result.current.data?.code).not.toBe('005930');
    await waitFor(() => expect(result.current.data?.code).toBe('000660'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  // Same-code refetch (e.g. lazy from/to extension) must keep stale-while-
  // revalidate UX — placeholder stays so the chart doesn't blank.
  it('keeps placeholder data when only from/to changes (same code)', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );
    await waitFor(() => expect(result.current.data?.code).toBe('005930'));
    rerender({ from: '20260430' });
    // Same code, different range — placeholder kept while the new fetch is in flight.
    expect(result.current.data?.code).toBe('005930');
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });
});
