import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
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

it('preserves stale quote flags from the backend', async () => {
  vi.spyOn(client, 'apiCall').mockResolvedValue({
    phase: 'open',
    quotes: [{
      code: '005930',
      price: 70000,
      change_pct: 1.2,
      change_won: 800,
      stale: true,
      stale_reason: 'rest_bypassed',
    }],
  });

  const res = await getQuotes(['005930']);

  expect(res.quotes[0].stale).toBe(true);
  expect(res.quotes[0].stale_reason).toBe('rest_bypassed');
});

it('includes venue in the request URL and query key', async () => {
  const spy = vi.spyOn(client, 'apiCall').mockResolvedValueOnce({
    phase: 'open',
    quotes: [],
  });

  await getQuotes(['005930'], 'UN');

  expect(spy).toHaveBeenCalledWith('/api/live/quotes?codes=005930&venue=UN');
  expect(liveQuotesQueryKey(['005930'], 'UN')).toEqual(['live-quotes', '005930', 'UN']);
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

  it('does not rehydrate a previous quote as fresh when the backend returns an empty batch', async () => {
    const spy = vi.spyOn(client, 'apiCall')
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [{ code: '005930', price: 72400, change_pct: 1.2, change_won: 100 }],
      })
      .mockResolvedValueOnce({
        phase: 'open',
        quotes: [],
      });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper });
    await waitFor(() => expect(result.current.quoteByCode.get('005930')?.price).toBe(72400));

    await act(async () => {
      await qc.refetchQueries({ queryKey: liveQuotesQueryKey(['005930']) });
    });

    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.quoteByCode.get('005930')).toBeUndefined());
  });

  it('preserves backend stale flags when the overlay refreshes a quote', async () => {
    vi.spyOn(client, 'apiCall').mockResolvedValue({
      phase: 'open',
      quotes: [{
        code: '005930',
        price: 70000,
        change_pct: 1.2,
        change_won: 800,
        stale: true,
        stale_reason: 'rest_bypassed',
      }],
    });

    const { result } = renderHook(() => useLiveQuoteOverlay(['005930']), { wrapper: wrap() });

    await waitFor(() => expect(result.current.quoteByCode.get('005930')).toMatchObject({
      stale: true,
      stale_reason: 'rest_bypassed',
    }));
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

describe('포커스 복귀 재조회 (마감 후 동결 방지)', () => {
  // 전역 기본(main.tsx)이 refetchOnWindowFocus:false 라, 그 조건을 재현하지 않으면
  // 훅의 override 를 지워도 테스트가 통과한다(테스트용 QueryClient 기본값은 true).
  // 이 wrapper 가 없으면 이 파일 전체가 회귀를 못 잡는다.
  function wrapWithGlobalFocusRefetchOff() {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
    });
    return ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
  }

  const CLOSED_RESPONSE = {
    phase: 'closed' as const,
    quotes: [{ code: '005930', price: 262500, change_pct: 26.81, change_won: 55500 }],
  };

  beforeEach(() => {
    focusManager.setFocused(undefined);
  });

  it('closed 에서 탭 복귀 시 재조회한다 — 600s 인터벌만으로는 영구 동결', async () => {
    const spy = vi.spyOn(client, 'apiCall').mockResolvedValue(CLOSED_RESPONSE);
    const { result } = renderHook(() => useQuoteByCode(['005930']), {
      wrapper: wrapWithGlobalFocusRefetchOff(),
    });
    await waitFor(() => expect(result.current.get('005930')?.price).toBe(262500));
    const beforeFocus = spy.mock.calls.length;

    // staleTime(10s) 경과를 **시계로만** 만든다. 가짜 타이머로 시간을 밀면 600s
    // 인터벌·리트라이 타이머까지 함께 돌아 무엇이 재조회를 유발했는지 흐려진다
    // (실제로 그렇게 짰을 때 초기 호출이 1회가 아니라 2회로 나왔다). 여기서
    // 검증할 건 "포커스가 재조회를 유발하는가" 하나뿐이므로 유발 요인을 하나만 남긴다.
    const frozenNow = Date.now() + 60_000;
    vi.spyOn(Date, 'now').mockReturnValue(frozenNow);

    await act(async () => {
      focusManager.setFocused(true);
    });

    await waitFor(() => expect(spy).toHaveBeenCalledTimes(beforeFocus + 1));
  });
});
