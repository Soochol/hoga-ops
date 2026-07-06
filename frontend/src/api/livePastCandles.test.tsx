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
  venue: 'KRX',
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
    expect(spy).toHaveBeenCalledWith(
      '/api/live/past-candles?code=005930&from=20260501&to=20260502&venue=KRX',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('passes an AbortSignal to apiCall', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useLivePastCandles('005930', '20260501', '20260502'), { wrapper: wrap(qc) });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const secondArg = spy.mock.calls[0][1] as RequestInit | undefined;
    expect(secondArg?.signal).toBeInstanceOf(AbortSignal);
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

  it('venue changes split cache entries and URL params', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ venue }: { venue: 'KRX' | 'NXT' }) => useLivePastCandles('005930', '20260501', '20260502', venue),
      { wrapper: wrap(qc), initialProps: { venue: 'KRX' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ venue: 'NXT' });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toContain('venue=NXT');
  });

  it('drops placeholder data when venue changes for the same code', async () => {
    let resolveNxt: (value: LivePastCandlesResponse) => void = () => {};
    const nxtPending = new Promise<LivePastCandlesResponse>((resolve) => {
      resolveNxt = resolve;
    });
    const krxResponse = { ...RESPONSE, venue: 'KRX' as const, candles: [{ ...RESPONSE.candles[0], close: 100 }] };
    const nxtResponse = { ...RESPONSE, venue: 'NXT' as const, candles: [{ ...RESPONSE.candles[0], close: 200 }] };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      url.includes('venue=NXT') ? nxtPending : Promise.resolve(krxResponse),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ venue }: { venue: 'KRX' | 'NXT' }) =>
        useLivePastCandles('005930', '20260501', '20260502', venue),
      { wrapper: wrap(qc), initialProps: { venue: 'KRX' } },
    );
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(100));

    rerender({ venue: 'NXT' });

    expect(result.current.data).toBeUndefined();
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    resolveNxt(nxtResponse);
    await waitFor(() => expect(result.current.data?.candles[0].close).toBe(200));
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

  it('fetches only the missing older delta when the range extends left', async () => {
    const firstResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260501',
      to: '20260502',
      candles: [{ ...RESPONSE.candles[0], t_ms: 2, close: 102 }],
      cached_dates: ['20260501'],
      fresh_dates: ['20260502'],
      effective_sessions: [
        { date: '20260501', venue: 'KRX', open_ms: 1, close_ms: 2 },
      ],
    };
    const deltaResponse: LivePastCandlesResponse = {
      ...RESPONSE,
      from: '20260430',
      to: '20260430',
      candles: [{ ...RESPONSE.candles[0], t_ms: 1, close: 101 }],
      cached_dates: [],
      fresh_dates: ['20260430'],
      effective_sessions: [
        { date: '20260430', venue: 'KRX', open_ms: 1, close_ms: 2 },
      ],
    };
    const spy = vi.spyOn(client, 'apiCall').mockImplementation((url) =>
      Promise.resolve(url.includes('from=20260430&to=20260430') ? deltaResponse : firstResponse),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result, rerender } = renderHook(
      ({ from }: { from: string }) =>
        useLivePastCandles('005930', from, '20260502'),
      { wrapper: wrap(qc), initialProps: { from: '20260501' } },
    );

    await waitFor(() => expect(result.current.data?.from).toBe('20260501'));
    rerender({ from: '20260430' });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260430&to=20260430&venue=KRX',
    );
    await waitFor(() => expect(result.current.data?.candles.map((c) => c.close)).toEqual([101, 102]));
    expect(result.current.data?.from).toBe('20260430');
    expect(result.current.data?.to).toBe('20260502');
    expect(result.current.data?.cached_dates).toEqual(['20260501']);
    expect(result.current.data?.fresh_dates).toEqual(['20260430', '20260502']);
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a previous range when the requested to-date changes', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = renderHook(
      ({ from, to }: { from: string; to: string }) =>
        useLivePastCandles('005930', from, to),
      { wrapper: wrap(qc), initialProps: { from: '20260501', to: '20260502' } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));

    rerender({ from: '20260430', to: '20260503' });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
    expect(spy.mock.calls[1][0]).toBe(
      '/api/live/past-candles?code=005930&from=20260430&to=20260503&venue=KRX',
    );
  });
});
