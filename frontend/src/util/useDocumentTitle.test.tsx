import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as client from '../api/client';
import { liveQuotesQueryKey } from '../api/liveQuotes';
import { useDocumentTitle, useStaticDocumentTitle } from './useDocumentTitle';
import { SYMBOLS_QUERY_KEY } from '../capture/useSymbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';

const HITS: SymbolHit[] = [
  {
    code: '005930',
    name: '삼성전자',
    market: 'KOSPI',
    captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
  },
];

function seedQuote(
  qc: QueryClient,
  code: string,
  quote: { price: number; change_pct: number | null; change_won: number | null; stale?: boolean; stale_reason?: string | null },
  venue: 'KRX' | 'NXT' | 'UN' = 'KRX',
) {
  qc.setQueryData(liveQuotesQueryKey([code], venue), {
    phase: 'open',
    quotes: [{ code, ...quote }],
  });
}

function makeQc(seedSymbols: SymbolsAllResponse | undefined) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (seedSymbols) {
    // Seed the cache so useSymbols() returns synchronously without hitting fetch.
    qc.setQueryData(SYMBOLS_QUERY_KEY, seedSymbols);
  }
  return qc;
}

function wrap(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => {
  document.title = 'before-test';
  // Block accidental network resolution. Most tests seed symbols/quotes in
  // React Query; unseeded queries stay pending so the hook exercises fallback
  // states without mixing Symbols and Live Quote response shapes.
  vi.spyOn(client, 'apiCall').mockReturnValue(new Promise<never>(() => {}));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDocumentTitle', () => {
  it('sets document.title to "hoga-ops" when code is null', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle(null), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('sets document.title to "hoga-ops" for whitespace-only code', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('   '), { wrapper: wrap(qc) });
    expect(document.title).toBe('hoga-ops');
  });

  it('resolves a known code to its Symbol Master name', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
  });

  it('includes live price and positive change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 71,200 +1.23%');
  });

  it('includes live price and negative change percent when quote is cached', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70500, change_pct: -0.8, change_won: -570 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,500 -0.80%');
  });

  it('includes live price and zero change percent without a plus sign', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: 0, change_won: 0 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000 0.00%');
  });

  it('omits change percent when the live quote has null change_pct', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', { price: 70000, change_pct: null, change_won: null });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 70,000');
  });

  it('does not present stale live quote values in the browser title as current truth', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '005930', {
      price: 70000,
      change_pct: 2.34,
      change_won: 1600,
      stale: true,
      stale_reason: 'kis_rest_bypassed',
    });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
  });

  it('falls back to the raw code when Symbol Master has no match', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999');
  });

  it('falls back to the raw code while Symbol Master is still loading', () => {
    const qc = makeQc(undefined);
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('005930');
  });

  it('updates document.title when code changes', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { rerender } = renderHook(
      ({ code }: { code: string | null }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: null } as { code: string | null } },
    );
    expect(document.title).toBe('hoga-ops');
    rerender({ code: '005930' });
    expect(document.title).toBe('삼성전자');
  });

  it('updates the title when the live quote arrives after the initial render', async () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');

    qc.setQueryData(liveQuotesQueryKey(['005930'], 'KRX'), {
      phase: 'open',
      quotes: [{ code: '005930', price: 71200, change_pct: 1.23, change_won: 860 }],
    });

    await waitFor(() => {
      expect(document.title).toBe('삼성전자 71,200 +1.23%');
    });
  });

  it('does not attach the previous code quote while the new code quote is loading', () => {
    const qc = makeQc({
      symbols: [
        ...HITS,
        {
          code: '000660',
          name: 'SK하이닉스',
          market: 'KOSPI',
          captured_count: 0,
          captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 },
        },
      ],
      status: 'fresh',
      fetched_at_ms: 1,
    });
    seedQuote(qc, '005930', { price: 71200, change_pct: 1.23, change_won: 860 });

    const { rerender } = renderHook(
      ({ code }: { code: string }) => useDocumentTitle(code),
      { wrapper: wrap(qc), initialProps: { code: '005930' } },
    );
    expect(document.title).toBe('삼성전자 71,200 +1.23%');

    rerender({ code: '000660' });
    expect(document.title).toBe('SK하이닉스');
  });

  it('uses the raw Code as the title base when Symbol Master has no match but quote exists', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    seedQuote(qc, '999999', { price: 12345, change_pct: 4.56, change_won: 540 });
    renderHook(() => useDocumentTitle('999999'), { wrapper: wrap(qc) });
    expect(document.title).toBe('999999 12,345 +4.56%');
  });

  it('restores "hoga-ops" on unmount', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { unmount } = renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});

describe('useStaticDocumentTitle', () => {
  it('sets document.title to a static page label', () => {
    renderHook(() => useStaticDocumentTitle('Heatmap'));
    expect(document.title).toBe('Heatmap');
  });

  it('sets document.title to "hoga-ops" when title is null', () => {
    renderHook(() => useStaticDocumentTitle(null));
    expect(document.title).toBe('hoga-ops');
  });

  it('restores "hoga-ops" on unmount', () => {
    const { unmount } = renderHook(() => useStaticDocumentTitle('Capture'));
    expect(document.title).toBe('Capture');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});
