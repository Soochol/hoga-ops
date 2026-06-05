import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { useReorderEntries } from './useWatchlist';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useReorderEntries (optimistic)', () => {
  beforeEach(() => vi.restoreAllMocks());
  it('reorders the cached entries before the request resolves', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(WATCHLIST_KEY, {
      folders: [], next_run_at_ms: 0,
      entries: [
        { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
        { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 1 },
      ],
    });
    let resolve!: () => void;
    vi.spyOn(api, 'reorderEntries').mockReturnValue(new Promise<void>((r) => { resolve = () => r(); }));
    const { result } = renderHook(() => useReorderEntries(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: null, orderedCodes: ['000660', '005930'] });
    await waitFor(() => {
      const data = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
      const byOrder = [...data.entries].sort((a, b) => a.order - b.order);
      expect(byOrder.map((e) => e.code)).toEqual(['000660', '005930']);
    });
    resolve();
  });

  it('rolls back the optimistic cache when the request rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(WATCHLIST_KEY, {
      folders: [], next_run_at_ms: 0,
      entries: [
        { code: '005930', name: '삼성', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 0 },
        { code: '000660', name: 'SK', registered_at_kst_date: '20260101', last_success_date: null, folder_id: null, order: 1 },
      ],
    });
    vi.spyOn(api, 'reorderEntries').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReorderEntries(), { wrapper: wrap(qc) });
    result.current.mutate({ folderId: null, orderedCodes: ['000660', '005930'] });
    // optimistic flips to 000660,005930 then onError restores ctx.prev (005930,000660)
    await waitFor(() => {
      const data = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
      expect([...data.entries].sort((a, b) => a.order - b.order).map((e) => e.code)).toEqual(['005930', '000660']);
    });
  });
});
