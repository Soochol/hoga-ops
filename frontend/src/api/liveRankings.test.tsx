import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import * as client from './client';
import { useLiveRankings, type RankingKind } from './liveRankings';
import { useLiveVenueStore } from '../state/liveVenue';

const RESPONSE = {
  rows: [], market_open: true, fetched_at_ms: 1_700_000_000_000, venue: 'KRX',
};

beforeEach(() => {
  vi.useFakeTimers();
  useLiveVenueStore.setState({ venue: 'KRX' });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function mount(kind: RankingKind) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const hook = renderHook(() => useLiveRankings({ kind, market: 'all', direction: 'down', excludeEtf: false }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    ),
  });
  return { ...hook, qc };
}

describe('live ranking polling', () => {
  it.each([['program', 30_000], ['institution', 30_000], ['foreign', 30_000], ['change', 10_000]] as const)(
    '%s polls after %i ms while open', async (kind, interval) => {
      const call = vi.spyOn(client, 'apiCall').mockResolvedValue(RESPONSE as never);
      const { qc } = mount(kind);
      await act(async () => { await vi.advanceTimersByTimeAsync(interval - 1); });
      expect(call).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(call).toHaveBeenCalledTimes(2);
      if (kind !== 'change') expect(call.mock.calls[0][0]).toContain('direction=up');
      qc.clear();
    },
  );

  it.each(['institution', 'foreign'] as const)('%s preserves unsupported ranking venue and selected quote venue', async (kind) => {
    const call = vi.spyOn(client, 'apiCall').mockResolvedValue({
      ...RESPONSE, market_open: false, venue: null, quote_venue: 'UN',
    } as never);
    const { qc, result } = mount(kind);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(result.current.data?.venue).toBeNull();
    expect(result.current.data?.quoteVenue).toBe('UN');
    await act(async () => { await vi.advanceTimersByTimeAsync(59_998); });
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(call).toHaveBeenCalledTimes(2);
    await act(async () => { useLiveVenueStore.setState({ venue: 'NXT' }); });
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2][0]).toContain('venue=NXT');
    qc.clear();
  });

  it('program polls after 60 seconds off-hours and changing venue fetches a separate snapshot', async () => {
    const call = vi.spyOn(client, 'apiCall').mockResolvedValue({ ...RESPONSE, market_open: false } as never);
    const { qc } = mount('program');
    await act(async () => { await vi.advanceTimersByTimeAsync(59_999); });
    expect(call).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(call).toHaveBeenCalledTimes(2);
    await act(async () => { useLiveVenueStore.setState({ venue: 'NXT' }); });
    expect(call).toHaveBeenCalledTimes(3);
    expect(call.mock.calls[2][0]).toContain('venue=NXT');
    qc.clear();
  });
});
