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
    captured_breakdown: { complete: 3, source_partial: 0, client_incomplete: 0, invalid: 0 } },
  { code: '005935', name: '삼성전자우', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
  { code: '000660', name: 'SK하이닉스', market: 'KOSPI', captured_count: 0,
    captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
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
  it.each([
    ['0158S0', ['0158S0']], ['0158s', ['0158S0']], ['엘리스', ['0158S0']],
    ['q500', ['Q500093']], ['q', ['Q500093', '012345']], ['missing', []],
  ] as const)('matches alphanumeric codes and names: %s', (query, expected) => {
    const hits: SymbolHit[] = [
      { ...HITS[0], code: '0158S0', name: '엘리스' },
      { ...HITS[0], code: 'Q500093', name: '테스트 ETN' },
      { ...HITS[0], code: '012345', name: 'Q서비스' },
    ];
    expect(filterSymbols(hits, query, 20).map((h) => h.code)).toEqual(expected);
  });
  it('prioritizes exact codes, deduplicates name matches and applies the limit', () => {
    const hits = [
      { ...HITS[0], code: 'Q500093', name: 'ETN' },
      { ...HITS[0], code: '000001', name: 'Q50009' },
      { ...HITS[0], code: 'Q50009', name: '주식 Q50009' },
    ];
    expect(filterSymbols(hits, 'q50009', 20).map((h) => h.code)).toEqual(['Q50009', 'Q500093', '000001']);
    expect(filterSymbols(hits, 'q50009', 1).map((h) => h.code)).toEqual(['Q50009']);
  });
  it('prefix matches sort before substring matches', () => {
    const extra: SymbolHit[] = [
      { code: '111111', name: '미래에셋삼성', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      ...HITS,
    ];
    const out = filterSymbols(extra, '삼성', 10);
    expect(out[0].name.startsWith('삼성')).toBe(true);
    expect(out[1].name.startsWith('삼성')).toBe(true);
  });
  it('name match is case-insensitive', () => {
    const en: SymbolHit[] = [
      { code: '058850', name: 'KTcs', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '010950', name: 'S-Oil', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '001040', name: 'CJ', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
    ];
    expect(filterSymbols(en, 'ktcs', 10).map((h) => h.code)).toEqual(['058850']);
    expect(filterSymbols(en, 'S-OIL', 10).map((h) => h.code)).toEqual(['010950']);
    expect(filterSymbols(en, 'cj', 10).map((h) => h.code)).toEqual(['001040']);
  });
  it('case-insensitive query keeps prefix-first then length ordering', () => {
    const en: SymbolHit[] = [
      { code: '000120', name: 'CJ대한통운', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
      { code: '001040', name: 'CJ', market: 'KOSPI', captured_count: 0,
        captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0, invalid: 0 } },
    ];
    // 'cj'는 둘 다 접두사 매칭(ap=bp=0) → 이름 길이순: 'CJ'(2자)가 'CJ대한통운'보다 앞
    expect(filterSymbols(en, 'cj', 10).map((h) => h.code)).toEqual(['001040', '000120']);
  });
  it('respects limit', () => {
    expect(filterSymbols(HITS, '', 2)).toHaveLength(2);
  });
});

describe('useSymbols', () => {
  it('polls lightweight count status and reloads the catalog when counts finish', async () => {
    let catalogCalls = 0;
    let statusCalls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      if (String(url).endsWith('/config.json')) {
        return { ok: true, status: 200, json: async () => ({ api_url: 'http://127.0.0.1:8000' }) } as Response;
      }
      if (String(url).endsWith('/capture-counts')) {
        statusCalls += 1;
        return { ok: true, status: 200,
          json: async () => ({ status: statusCalls === 1 ? 'pending' : 'ready' }) } as Response;
      }
      catalogCalls += 1;
      const status = catalogCalls === 1 ? 'pending' : 'ready';
      return { ok: true, status: 200, json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1,
        capture_counts_status: status }) } as Response;
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbols(), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.data?.capture_counts_status).toBe('ready'), { timeout: 6000 });
    expect(catalogCalls).toBe(2);
    expect(statusCalls).toBe(2);
  });

  it('fires one fetch and exposes the envelope on data', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch' as const).mockResolvedValue({
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
    vi.spyOn(globalThis, 'fetch' as const).mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ symbols: HITS, status: 'fresh', fetched_at_ms: 1 }),
    } as Response);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useSymbolSearch('삼성', 10), { wrapper: wrap(qc) });
    await waitFor(() => expect(result.current.length).toBe(2));
    expect(result.current.map((h) => h.code)).toEqual(['005930', '005935']);
  });
});
