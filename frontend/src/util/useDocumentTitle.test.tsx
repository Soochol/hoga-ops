import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useDocumentTitle } from './useDocumentTitle';
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
  // Block any accidental network fetch — useSymbols falls back to data:undefined.
  vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ symbols: [], status: 'fresh', fetched_at_ms: 1 }),
  } as Response);
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

  it('appends the live timeframe label when provided', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    renderHook(() => useDocumentTitle('005930', '5m'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자 5분봉');
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

  it('restores "hoga-ops" on unmount', () => {
    const qc = makeQc({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 });
    const { unmount } = renderHook(() => useDocumentTitle('005930'), { wrapper: wrap(qc) });
    expect(document.title).toBe('삼성전자');
    unmount();
    expect(document.title).toBe('hoga-ops');
  });
});
