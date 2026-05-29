import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useInventoryUnblock } from './useInventoryUnblock';
import { STOCK_DATES_QUERY_KEY } from '../api/stock-dates';

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
}

function setupFetch(action: 'unblocked' | 'noop' = 'unblocked') {
  return vi.spyOn(globalThis, 'fetch' as 'fetch').mockImplementation(async (url) => {
    const s = String(url);
    if (s.includes('/config.json')) {
      return { ok: true, status: 200, json: async () => ({ api_url: '' }) } as Response;
    }
    if (s.includes('/api/captures/items/') && s.includes('/unblock')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: '005930', date: '20260520', fail_streak: 0, action }),
      } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  });
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('useInventoryUnblock', () => {
  it('POSTs to /api/captures/items/{code}/{date}/unblock', async () => {
    const fetchMock = setupFetch();
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const { result } = renderHook(() => useInventoryUnblock(), { wrapper: wrapper(qc) });

    await act(async () => {
      await result.current.unblock.mutateAsync({ code: '005930', date: '20260520' });
    });

    // apiCall goes through loadConfig() which itself does a fetch for
    // /config.json — find our POST among the calls.
    const call = fetchMock.mock.calls.find((c) =>
      String(c[0]).includes('/api/captures/items/'),
    );
    expect(call, 'unblock POST was issued').toBeDefined();
    expect(String(call![0])).toContain('/api/captures/items/005930/20260520/unblock');
    expect((call![1] as RequestInit).method).toBe('POST');
  });

  it('invalidates the inventory query on success (action: unblocked)', async () => {
    setupFetch('unblocked');
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useInventoryUnblock(), { wrapper: wrapper(qc) });

    await act(async () => {
      await result.current.unblock.mutateAsync({ code: '005930', date: '20260520' });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: STOCK_DATES_QUERY_KEY });
    });
  });

  it('treats action=noop the same as unblocked (invalidates either way)', async () => {
    setupFetch('noop');
    const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const { result } = renderHook(() => useInventoryUnblock(), { wrapper: wrapper(qc) });

    await act(async () => {
      await result.current.unblock.mutateAsync({ code: '005930', date: '20260520' });
    });

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: STOCK_DATES_QUERY_KEY });
    });
  });
});
