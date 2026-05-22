import { describe, expect, it, beforeEach, vi } from 'vitest';
import { getAllSymbols, searchSymbols, refreshSymbols } from './symbols';

beforeEach(() => {
  vi.restoreAllMocks();
});

function mockFetch(body: unknown, ok = true) {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockResolvedValue({
    ok,
    status: ok ? 200 : 500,
    json: async () => body,
  } as Response);
}

describe('symbols api', () => {
  it('getAllSymbols returns the SymbolsAllResponse envelope', async () => {
    mockFetch({
      symbols: [
        {
          code: '005930',
          name: '삼성전자',
          market: 'KOSPI',
          captured_count: 0,
          captured_breakdown: { complete: 0, source_partial: 0, client_incomplete: 0 },
        },
      ],
      status: 'fresh',
      fetched_at_ms: 1_700_000_000_000,
    });
    const resp = await getAllSymbols();
    expect(resp.status).toBe('fresh');
    expect(resp.symbols[0].code).toBe('005930');
  });

  it('searchSymbols posts q + limit and returns the SymbolHit list', async () => {
    const f = mockFetch([
      {
        code: '005930',
        name: '삼성전자',
        market: 'KOSPI',
        captured_count: 14,
        captured_breakdown: { complete: 14, source_partial: 0, client_incomplete: 0 },
      },
    ]);
    const hits = await searchSymbols('삼성', 5);
    expect(f).toHaveBeenCalled();
    const url = f.mock.calls[0][0] as string;
    expect(url).toContain('/api/symbols?');
    expect(url).toContain('q=%EC%82%BC%EC%84%B1'); // url-encoded "삼성"
    expect(url).toContain('limit=5');
    expect(hits[0].captured_count).toBe(14);
  });

  it('refreshSymbols POSTs to /api/symbols/refresh and returns the envelope', async () => {
    const f = mockFetch({ symbols: [], status: 'fresh', fetched_at_ms: 1 });
    await refreshSymbols();
    expect(f.mock.calls[0][1]?.method).toBe('POST');
  });

  it('getAllSymbols throws with detail on non-ok response', async () => {
    mockFetch({ detail: { message: 'down' } }, false);
    await expect(getAllSymbols()).rejects.toThrow();
  });
});
