import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWatchlistMembership } from './useWatchlistMembership';
import * as watchlistApi from '../api/watchlist';

function wrapper(codes: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['watchlist'], {
    entries: codes.map((code) => ({ code, name: code, registered_at_kst_date: '20260101', last_success_date: null })),
    next_run_at_ms: 0,
  });
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe('useWatchlistMembership', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('isMember reflects the seeded watchlist', () => {
    const { result } = renderHook(() => useWatchlistMembership(), { wrapper: wrapper(['005930']) });
    expect(result.current.isMember('005930')).toBe(true);
    expect(result.current.isMember('000660')).toBe(false);
  });

  it('toggle adds a non-member', async () => {
    const spy = vi.spyOn(watchlistApi, 'addToWatchlist').mockResolvedValue({} as never);
    const { result } = renderHook(() => useWatchlistMembership(), { wrapper: wrapper([]) });
    await act(async () => { result.current.toggle('005930'); });
    expect(spy).toHaveBeenCalledWith('005930');
  });

  it('toggle removes a member', async () => {
    const spy = vi.spyOn(watchlistApi, 'removeFromWatchlist').mockResolvedValue(undefined as never);
    const { result } = renderHook(() => useWatchlistMembership(), { wrapper: wrapper(['005930']) });
    await act(async () => { result.current.toggle('005930'); });
    expect(spy).toHaveBeenCalledWith('005930');
  });
});
