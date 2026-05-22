import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useSymbols, useSymbolSearch, filterSymbols } from './useSymbols';
import type { SymbolHit } from '../api/types';

function wrap(qc: QueryClient) {
  return function W({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

const HITS: SymbolHit[] = [
  { code: '005930', name: '삼성전자', market: 'KOSPI', captured_count: 3,
    captured_breakdown: { complete: 3, source_partial: 0, client_incomplete: 0 } },
  { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
];

describe('filterSymbols', () => {
  it('returns all symbols (up to limit) for empty query', () => {
    expect(filterSymbols(HITS, '', 10)).toHaveLength(3);
  });
  it('numeric query → code prefix match', () => {
    expect(filterSymbols(HITS, '00593', 10).map((h) => h.code)).toEqual(['005930', '005935']);
  });
  it('name substring match', () => {
    expect(filterSymbols(HITS, '삼성', 10).map((h) => h.code)).toEqual(['005930', '005935']);
  });
  it('prefix matches sort before substring matches', () => {
    const extra: SymbolHit[] = [
      { code: '111111', name: '미래에셋삼성', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 } },
      ...HITS,
    ];
    const out = filterSymbols(extra, '삼성', 10);
    expect(out[0].name.startsWith('삼성')).toBe(true);
    expect(out[1].name.startsWith('삼성')).toBe(true);
  });
  it('respects limit', () => {
    expect(filterSymbols(HITS, '', 2)).toHaveLength(2);
  });
});

describe('useSymbols', () => {
  it('fires one fetch and exposes the envelope on data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbols(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.status).toBe('fresh');
    expect(result.current.data?.symbols).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalled();
  });
});

describe('useSymbolSearch', () => {
  it('returns the filtered list from the cached SymbolsAllResponse', async () => {
    vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbolSearch('삼성', 10), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((h) => h.code)).toEqual(['005930', '005935']);
  });
});
