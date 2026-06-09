import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as api from '../api/watchlist';
import { WATCHLIST_KEY } from './watchlistKeys';
import { useReorderFolders } from './useWatchlist';

function wrap(qc: QueryClient) {
  return ({ children }: { children: React.ReactNode }) =>
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const seed = (qc: QueryClient) =>
  qc.setQueryData(WATCHLIST_KEY, {
    next_run_at_ms: 0, entries: [],
    folders: [
      { id: 'f_a', name: '스윙', order: 0 },
      { id: 'f_b', name: '장기', order: 1 },
      { id: 'f_c', name: '단타', order: 2 },
    ],
  });

const orderOf = (qc: QueryClient) => {
  const d = qc.getQueryData(WATCHLIST_KEY) as api.WatchlistResponse;
  return [...d.folders].sort((a, b) => a.order - b.order).map((f) => f.id);
};

describe('useReorderFolders (optimistic)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('reorders the cached folders before the request resolves', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    let resolve!: () => void;
    vi.spyOn(api, 'reorderFolders').mockReturnValue(new Promise<void>((r) => { resolve = () => r(); }));
    const { result } = renderHook(() => useReorderFolders(), { wrapper: wrap(qc) });
    result.current.mutate(['f_c', 'f_a', 'f_b']);
    await waitFor(() => expect(orderOf(qc)).toEqual(['f_c', 'f_a', 'f_b']));
    resolve();
  });

  it('rolls back the optimistic cache when the request rejects', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    seed(qc);
    vi.spyOn(api, 'reorderFolders').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReorderFolders(), { wrapper: wrap(qc) });
    result.current.mutate(['f_c', 'f_a', 'f_b']);
    // 낙관적으로 c,a,b 로 뒤집힌 뒤 onError가 ctx.prev(a,b,c)로 복원
    await waitFor(() => expect(orderOf(qc)).toEqual(['f_a', 'f_b', 'f_c']));
  });
});
