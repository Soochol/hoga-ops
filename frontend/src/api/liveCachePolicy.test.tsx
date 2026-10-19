import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { evictExcessMergedLiveRanges, mergedLiveRangeKey } from './range';
import {
  estimateLivePayloadBytes, liveCacheStats, setLiveCacheOpenCodes,
  trimRetainedLiveCaches, useLiveCacheConsumer,
} from './liveCachePolicy';

function seed(client: QueryClient, code: string, updatedAt: number, rows = 1) {
  const key = mergedLiveRangeKey(JSON.stringify(['range', code, null, '20261019', 60_000]));
  client.setQueryData(key, { code, candles: Array.from({ length: rows }, () => ({ t: 1, close: 2 })) }, { updatedAt });
  return key;
}

describe('retained live cache policy', () => {
  it('keeps only the most recently used closed codes and preserves open codes', () => {
    const client = new QueryClient();
    const old = seed(client, 'old', 1);
    const recent = seed(client, 'recent', 2);
    const open = seed(client, 'open', 0);
    setLiveCacheOpenCodes(client, new Set(['open']));
    trimRetainedLiveCaches(client, Infinity, 1);
    expect(client.getQueryData(old)).toBeUndefined();
    expect(client.getQueryData(recent)).toBeDefined();
    expect(client.getQueryData(open)).toBeDefined();
    expect(liveCacheStats(client).evictions.recentCodes).toBe(1);
  });

  it('accounts for payload size instead of only entry count', () => {
    const client = new QueryClient();
    const large = seed(client, 'large', 1, 1000);
    const small = seed(client, 'small', 2);
    const smallBytes = estimateLivePayloadBytes(client.getQueryData(small));
    trimRetainedLiveCaches(client, smallBytes, 6);
    expect(client.getQueryData(large)).toBeUndefined();
    expect(client.getQueryData(small)).toBeDefined();
    expect(liveCacheStats(client).estimatedBytes).toBe(smallBytes);
    expect(liveCacheStats(client).evictions.bytes).toBe(1);
  });

  it('protects mounted merged identities from capacity eviction', () => {
    const client = new QueryClient();
    const key = seed(client, 'active', 1, 1000);
    const { unmount } = renderHook(() => useLiveCacheConsumer(client, key, true));
    trimRetainedLiveCaches(client, 0, 0);
    expect(client.getQueryData(key)).toBeDefined();
    expect(liveCacheStats(client).protectedEntries).toBe(1);
    unmount();
    trimRetainedLiveCaches(client, 0, 0);
    expect(client.getQueryData(key)).toBeUndefined();
  });

  it('starts idle GC after the last consumer leaves, not while the chart is mounted', async () => {
    vi.useFakeTimers();
    const client = new QueryClient({ defaultOptions: { queries: { gcTime: 10 } } });
    try {
      const key = seed(client, 'active', 1);
      const { unmount } = renderHook(() => useLiveCacheConsumer(client, key, true));
      await act(() => vi.advanceTimersByTimeAsync(100));
      expect(client.getQueryData(key)).toBeDefined();
      unmount();
      await act(() => vi.advanceTimersByTimeAsync(10));
      expect(client.getQueryData(key)).toBeUndefined();
    } finally {
      client.clear();
      vi.useRealTimers();
    }
  });

  it('uses actual visits instead of fetch timestamps to evict merged identities', () => {
    const client = new QueryClient();
    const visited = seed(client, 'visited', 1);
    const fetched = seed(client, 'fetched', 2);
    const { unmount } = renderHook(() => useLiveCacheConsumer(client, visited, true));
    unmount();
    evictExcessMergedLiveRanges(client, 1);
    expect(client.getQueryData(visited)).toBeDefined();
    expect(client.getQueryData(fetched)).toBeUndefined();
  });

  it('reference counts simultaneous consumers and keeps query clients isolated', () => {
    const client = new QueryClient();
    const other = new QueryClient();
    const key = seed(client, 'same', 1);
    seed(other, 'same', 1);
    const a = renderHook(() => useLiveCacheConsumer(client, key, true));
    const b = renderHook(() => useLiveCacheConsumer(client, key, true));
    a.unmount();
    trimRetainedLiveCaches(client, 0, 0);
    trimRetainedLiveCaches(other, 0, 0);
    expect(client.getQueryData(key)).toBeDefined();
    expect(other.getQueryData(key)).toBeUndefined();
    b.unmount();
  });

  it('samples long histories without visiting every row or serializing them', () => {
    const row = { t: 1, levels: [{ price: 10, qty: 20 }] };
    const rows = Array(100_000).fill(row);
    const spy = vi.spyOn(JSON, 'stringify');
    expect(estimateLivePayloadBytes(rows)).toBeGreaterThan(100_000);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('reports raw range payloads separately from the merged retention budget', () => {
    const client = new QueryClient();
    seed(client, 'closed', 1);
    const raw = { points: [{ t: 1, qty: 2 }] };
    client.setQueryData(['range', 'closed'], raw);
    const emptyKey = mergedLiveRangeKey(JSON.stringify(['range', 'loading']));
    const { unmount } = renderHook(() => useLiveCacheConsumer(client, emptyKey, true));
    trimRetainedLiveCaches(client, 0, 0);
    expect(liveCacheStats(client)).toMatchObject({
      mergedEntries: 1, protectedEntries: 1, readyProtectedEntries: 0,
      estimatedBytes: 0, rangeEntries: 1, rangeEstimatedBytes: estimateLivePayloadBytes(raw),
    });
    expect(client.getQueryData(['range', 'closed'])).toEqual(raw);
    unmount();
    client.clear();
  });
});
