import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useQuoteByCode } from './liveQuotes';
import * as client from './client';

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

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
});
