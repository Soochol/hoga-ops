import { useEffect } from 'react';
import { QueryObserver, type Query, type QueryClient, type QueryKey } from '@tanstack/react-query';

// Retain expensive merged histories across code switches, within a shared
// estimated payload budget. This is not a measurement of the browser heap.
export const LIVE_CACHE_MAX_ESTIMATED_BYTES = 96 * 1024 * 1024;
export const LIVE_CACHE_RECENT_CODES = 6;

type Usage = { lastUsed: number; data: unknown; bytes: number };
type Policy = {
  usage: WeakMap<Query, Usage>;
  active: Map<string, number>;
  openCodes: Set<string>;
  evictions: { recentCodes: number; bytes: number; identities: number };
};
const policies = new WeakMap<QueryClient, Policy>();
function policy(client: QueryClient): Policy {
  let value = policies.get(client);
  if (!value) {
    value = { usage: new WeakMap(), active: new Map(), openCodes: new Set(), evictions: { recentCodes: 0, bytes: 0, identities: 0 } };
    policies.set(client, value);
  }
  return value;
}

export function codeFromMergedLiveRangeKey(key: QueryKey): string | null {
  if (key[0] !== 'live' || key[1] !== 'range-merged' || typeof key[2] !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(key[2]);
    return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : null;
  } catch { return null; }
}

export function isLiveMergedKey(key: QueryKey): boolean {
  return key[0] === 'live' && (key[1] === 'range-merged' || (key[1] === 'past-candles' && key[2] === 'merged'));
}

function codeOf(key: QueryKey): string | null {
  if (key[1] === 'range-merged') return codeFromMergedLiveRangeKey(key);
  return typeof key[3] === 'string' ? key[3] : null;
}

/** Bounded sampling of immutable wire arrays; cost does not grow with history.
 * Use the largest sampled row so a large day is not averaged away. Shared
 * objects may be counted twice; allocator and chart-owned copies are excluded. */
export function estimateLivePayloadBytes(value: unknown, depth = 0): number {
  if (value == null) return 4;
  if (typeof value === 'number') return 8;
  if (typeof value === 'boolean') return 4;
  if (typeof value === 'string') return 16 + value.length * 2;
  if (depth >= 8) return 128;
  if (Array.isArray(value)) {
    let row = 0;
    const samples = Math.min(value.length, 4);
    for (let i = 0; i < samples; i++) {
      const index = samples === 1 ? 0 : Math.floor(i * (value.length - 1) / (samples - 1));
      row = Math.max(row, estimateLivePayloadBytes(value[index], depth + 1));
    }
    return 24 + value.length * (8 + row);
  }
  if (typeof value === 'object') {
    let size = 32;
    for (const [key, item] of Object.entries(value)) size += key.length * 2 + estimateLivePayloadBytes(item, depth + 1);
    return size;
  }
  return 0;
}

function usage(client: QueryClient, query: Query): Usage {
  const state = policy(client);
  let entry = state.usage.get(query);
  if (!entry) {
    entry = { lastUsed: query.state.dataUpdatedAt, data: undefined, bytes: 0 };
    state.usage.set(query, entry);
  }
  if (entry.data !== query.state.data) {
    entry.data = query.state.data;
    entry.bytes = estimateLivePayloadBytes(entry.data);
  }
  return entry;
}

export function liveCacheLastUsed(client: QueryClient, query: Query): number {
  return policy(client).usage.get(query)?.lastUsed ?? query.state.dataUpdatedAt;
}

export function recordLiveCacheIdentityEviction(client: QueryClient): void {
  policy(client).evictions.identities++;
}

export function isLiveCacheProtected(client: QueryClient, query: Query): boolean {
  return query.getObserversCount() > 0 || (policy(client).active.get(JSON.stringify(query.queryKey)) ?? 0) > 0;
}

/** A disabled observer keeps mounted snapshots out of React Query's idle GC.
 * Its no-op listener never drives React renders or network requests. */
export function useLiveCacheConsumer(client: QueryClient, key: QueryKey, enabled: boolean): void {
  const identity = JSON.stringify(key);
  useEffect(() => {
    if (!enabled) return;
    const state = policy(client);
    const queryKey = JSON.parse(identity) as QueryKey;
    const observer = new QueryObserver(client, { queryKey, enabled: false, structuralSharing: false });
    const unsubscribe = observer.subscribe(() => {});
    state.active.set(identity, (state.active.get(identity) ?? 0) + 1);
    const touch = () => {
      const query = client.getQueryCache().find({ queryKey, exact: true });
      if (query) usage(client, query).lastUsed = Date.now();
    };
    touch();
    return () => {
      touch();
      unsubscribe();
      const count = (state.active.get(identity) ?? 1) - 1;
      if (count) state.active.set(identity, count);
      else state.active.delete(identity);
    };
  }, [client, identity, enabled]);
}

export function setLiveCacheOpenCodes(client: QueryClient, codes: ReadonlySet<string>): void {
  policy(client).openCodes = new Set(codes);
}

export function trimRetainedLiveCaches(
  client: QueryClient,
  maxBytes = LIVE_CACHE_MAX_ESTIMATED_BYTES,
  maxRecentCodes = LIVE_CACHE_RECENT_CODES,
): void {
  const state = policy(client);
  const queries = client.getQueryCache().findAll({ queryKey: ['live'], predicate: q => isLiveMergedKey(q.queryKey) });
  const ordered = [...queries].sort((a, b) => liveCacheLastUsed(client, b) - liveCacheLastUsed(client, a));
  const recent = new Set<string>();
  let bytes = 0;
  for (const query of ordered) {
    const code = codeOf(query.queryKey);
    if (code && !state.openCodes.has(code) && recent.size < maxRecentCodes) recent.add(code);
    bytes += usage(client, query).bytes;
  }
  for (const query of ordered.reverse()) {
    if (isLiveCacheProtected(client, query)) continue;
    const code = codeOf(query.queryKey);
    const outsideRecent = code !== null && !state.openCodes.has(code) && !recent.has(code);
    if (!outsideRecent && bytes <= maxBytes) continue;
    bytes -= usage(client, query).bytes;
    state.evictions[outsideRecent ? 'recentCodes' : 'bytes']++;
    client.removeQueries({ queryKey: query.queryKey, exact: true });
  }
}

export function liveCacheStats(client: QueryClient) {
  const queries = client.getQueryCache().findAll({ queryKey: ['live'], predicate: q => isLiveMergedKey(q.queryKey) });
  return {
    mergedEntries: queries.length,
    estimatedBytes: queries.reduce((sum, query) => sum + usage(client, query).bytes, 0),
    protectedEntries: queries.filter(query => isLiveCacheProtected(client, query)).length,
    maxEstimatedBytes: LIVE_CACHE_MAX_ESTIMATED_BYTES,
    maxRecentCodes: LIVE_CACHE_RECENT_CODES,
    evictions: { ...policy(client).evictions },
  };
}
