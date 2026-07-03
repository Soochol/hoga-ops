import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { getQuotes, liveQuotesQueryKey, useQuoteByCode, useLiveQuoteOverlay, quotesRefetchInterval } from './liveQuotes';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

it('accepts validated quote provenance fields', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValueOnce({
    phase: 'open',
    quotes: [{
      code: '049080',
      price: 7770,
      change_pct: -21.75,
      change_won: -2160,
      open: 7770,
      high: 7770,
      low: 7770,
      baseline_price: 9930,
      baseline_date: '2026-06-26',
      change_pct_source: 'adjusted_daily',
      warnings: ['kis_change_pct_rejected'],
    }],
  });

  const res = await getQuotes(['049080']);

  expect(res.quotes[0].change_pct).toBe(-21.75);
  expect(res.quotes[0].baseline_price).toBe(9930);
  expect(res.quotes[0].baseline_date).toBe('2026-06-26');
  expect(res.quotes[0].change_pct_source).toBe('adjusted_daily');
  expect(res.quotes[0].warnings).toEqual(['kis_change_pct_rejected']);
});

it('includes venue in the request URL and query key', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({
    phase: 'open',
    quotes: [],
  });

  await getQuotes(['005930'], 'NXT');

  expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=005930&venue=NXT');
  expect(liveQuotesQueryKey(['005930'], 'NXT')).toEqual(['live-quotes', '005930', 'NXT']);
});

it('dedupes codes before requesting quotes and building the query key', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({
    phase: 'open',
    quotes: [],
  });

  await getQuotes(['005930', '000660', '005930'], 'KRX');

  expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=000660,005930&venue=KRX');
  expect(liveQuotesQueryKey(['005930', '000660', '005930'], 'KRX')).toEqual([
    'live-quotes',
    '000660,005930',
    'KRX',
  ]);
});

describe('useQuoteByCode', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns an empty Map before quotes arrive (null-safe)', () => {
    // apiCall never resolves → query stays pending → data undefined
    vi.spyOn(client, 'apiCall').mockReturnValue(new Promise<never>(() => {}));
    const { result } = renderHook(() => useQuoteByCode(['005930']), { wrapper: wrap() });
    expect(result.current.size).toBe(0);
    expect(result.current.get('005930')).toBeUndefined();
  });

  it('maps each code to its live quote once loaded', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [
        { code: '005930', price: 72400, change_pct: 1.2 },
        { code: '000660', price: 183500, change_pct: -0.8 },
      ],
    });
    const { result } = renderHook(() => useQuoteByCode(['005930', '000660']), { wrapper: wrap() });
    await waitFor(() => expect(result.current.size).toBe(2));
    expect(result.current.get('005930')).toEqual({ code: '005930', price: 72400, change_pct: 1.2 });
    expect(result.current.get('000660')?.change_pct).toBe(-0.8);
  });

  it('does not fetch and returns an empty Map when codes is empty', () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue({ phase: 'open', quotes: [] });
    const { result } = renderHook(() => useQuoteByCode([]), { wrapper: wrap() });
    expect(result.current.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the previous quotes while a new codes set loads (placeholderData, no flash to —)', async () => {
    // First key resolves; the second key (different codes) never resolves so the
    // hook stays in the transition window. Without placeholderData the Map would
    // be empty here and every row would flash to '—'.
    vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({ phase: 'open', quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }] })
      .mockReturnValueOnce(new Promise<never>(() => {}));
    const { result, rerender } = renderHook((codes: string[]) => useQuoteByCode(codes), {
      wrapper: wrap(), initialProps: ['005930'],
    });
    await waitFor(() => expect(result.current.get('005930')?.price).toBe(72400));
    act(() => rerender(['000660']));
    // Previous data is retained during the new key's in-flight window.
    expect(result.current.get('005930')?.price).toBe(72400);
  });

  it('keeps last good change fields when a transient response marks them unavailable', async () => {
    const spy = vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }],
      })
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [{
          code: '005930',
          price: 72500,
          change_pct: null,
          change_won: null,
          change_pct_source: 'unavailable',
        }],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useQuoteByCode(['005930']), { wrapper });
    await waitFor(() => expect(result.current.get('005930')?.price).toBe(72400));

    await act(async () => {
      await qc.refetchQueries({ queryKey: liveQuotesQueryKey(['005930']) });
    });

    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.get('005930')?.price).toBe(72500));
    expect(result.current.get('005930')?.change_pct).toBe(1.2);
    expect(result.current.get('005930')?.change_won).toBe(100);
  });
});

describe('useLiveQuoteOverlay', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('quoteByCode + phase + dataUpdatedAt 를 한 인터페이스로 노출', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{ code: '005930', price: 70000, change_pct: 5, change_won: 3000 }],
    });
    const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper: wrap() });
    await waitFor(() => expect(result.current.quoteByCode.size).toBe(1));
    expect(result.current.quoteByCode.get('005930')?.price).toBe(70000);
    expect(result.current.phase).toBe('open');
    expect(typeof result.current.dataUpdatedAt).toBe('number');
  });

  it('미도착 시 빈 Map · phase undefined (null-safe)', () => {
    vi.spyOn(client, 'apiCall').mockReturnValue(new Promise<never>(() => {}));
    const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper: wrap() });
    expect(result.current.quoteByCode.size).toBe(0);
    expect(result.current.phase).toBeUndefined();
  });
});

describe('quotesRefetchInterval', () => {
  it('closed면 600s 하트비트 — false 금지(다음 개장에 폴링 재개 불가)', () => {
    expect(quotesRefetchInterval('closed')).toBe(600_000);
  });

  it('open/pre_open/미도착(undefined)은 10s 유지', () => {
    expect(quotesRefetchInterval('open')).toBe(10_000);
    expect(quotesRefetchInterval('pre_open')).toBe(10_000);
    expect(quotesRefetchInterval(undefined)).toBe(10_000);
  });
});
