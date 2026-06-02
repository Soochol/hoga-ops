import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useReorderWatchlist } from './useWatchlist';
import * as api from '../api/watchlist';
import type { WatchlistResponse } from '../api/watchlist';

function seeded() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const initial: WatchlistResponse = {
    next_run_at_ms: 0,
    entries: [
      { code: '003490', name: '대한항공', registered_at_kst_date: '20260526', last_success_date: null },
      { code: '005930', name: '삼성전자', registered_at_kst_date: '20260526', last_success_date: null },
    ],
  };
  qc.setQueryData(['watchlist'], initial);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, wrapper };
}

const codesOf = (qc: QueryClient) =>
  (qc.getQueryData<WatchlistResponse>(['watchlist'])?.entries ?? []).map((e) => e.code);

describe('useReorderWatchlist', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('optimistically reorders the cache before the request resolves', async () => {
    // request never resolves → we observe the optimistic state only
    vi.spyOn(api, 'reorderWatchlist').mockReturnValue(new Promise<never>(() => {}));
    const { qc, wrapper } = seeded();
    const { result } = renderHook(() => useReorderWatchlist(), { wrapper });
    act(() => { result.current.mutate(['005930', '003490']); });
    await waitFor(() => expect(codesOf(qc)).toEqual(['005930', '003490']));
  });

  it('rolls back to the previous order on error', async () => {
    vi.spyOn(api, 'reorderWatchlist').mockRejectedValue(new Error('boom'));
    const { qc, wrapper } = seeded();
    const { result } = renderHook(() => useReorderWatchlist(), { wrapper });
    act(() => { result.current.mutate(['005930', '003490']); });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(codesOf(qc)).toEqual(['003490', '005930']); // restored
  });
});
