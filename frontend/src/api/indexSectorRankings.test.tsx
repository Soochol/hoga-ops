import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

import {
  TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS,
  indexSectorRankingFreshnessOptions,
  useIndexSectorRankings,
} from './indexSectorRankings';
import { __resetConfigForTests } from './client';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useIndexSectorRankings', () => {
  beforeEach(() => {
    __resetConfigForTests();
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.endsWith('/config.json')) {
        return new Response(JSON.stringify({ apiBaseUrl: 'http://api.test', wsBaseUrl: 'ws://api.test' }));
      }
      return new Response(JSON.stringify({
        date: '20260619',
        source: 'daily_adjusted',
        unavailable_reason: null,
        sectors: [],
      }));
    }));
  });

  it('fetches one ranking payload for the basis date', async () => {
    const { result } = renderHook(() => useIndexSectorRankings('20260619'), { wrapper });

    await waitFor(() => expect(result.current.data?.date).toBe('20260619'));

    expect(fetch).toHaveBeenCalledWith(
      'http://api.test/api/live/index-sector-rankings?date=20260619',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('does not fetch when date is null', () => {
    renderHook(() => useIndexSectorRankings(null), { wrapper });

    expect(fetch).toHaveBeenCalledTimes(0);
  });
});

describe('indexSectorRankingFreshnessOptions', () => {
  it('refetches today rankings while the same basis date can change intraday', () => {
    expect(indexSectorRankingFreshnessOptions('20260619', '20260619')).toEqual({
      staleTime: TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS,
      refetchInterval: TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS,
    });
  });

  it('does not poll historical ranking dates', () => {
    expect(indexSectorRankingFreshnessOptions('20260618', '20260619')).toEqual({
      staleTime: TODAY_INDEX_SECTOR_RANKINGS_REFETCH_MS,
      refetchInterval: false,
    });
  });
});
