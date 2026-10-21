import { useMemo } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getAllSymbols, getCaptureCountsInfo } from '../api/symbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';
import { SYMBOLS_QUERY_KEY } from './symbolKeys';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export { SYMBOLS_QUERY_KEY } from './symbolKeys';

export function useSymbols() {
  const client = useQueryClient();
  return useQuery<SymbolsAllResponse>({
    queryKey: SYMBOLS_QUERY_KEY,
    queryFn: async () => {
      const previous = client.getQueryData<SymbolsAllResponse>(SYMBOLS_QUERY_KEY);
      // Poll a tiny status payload; fetch the full catalog only on completion,
      // failure, or explicit invalidation. All consumers share this query.
      if (previous?.capture_counts_status === 'pending'
        && !client.getQueryState(SYMBOLS_QUERY_KEY)?.isInvalidated) {
        const info = await getCaptureCountsInfo();
        if (info.status === 'pending') return previous;
      }
      return getAllSymbols();
    },
    staleTime: ONE_DAY_MS,
    refetchInterval: (query) => query.state.data?.capture_counts_status === 'pending' ? 1000 : false,
  });
}

export function filterSymbols(hits: SymbolHit[], q: string, limit: number): SymbolHit[] {
  const norm = q.trim();
  if (norm.length === 0) return hits.slice(0, limit);
  if (/^\d+$/.test(norm)) {
    return hits.filter((h) => h.code.startsWith(norm)).slice(0, limit);
  }
  // Match alphanumeric KRX/ETN codes without losing English name matches.
  const upper = norm.toUpperCase();
  const codeMatches = hits.filter((h) => h.code.startsWith(upper));
  codeMatches.sort((a, b) => Number(b.code === upper) - Number(a.code === upper));
  // Name match (case-insensitive): prefix-matches first, then substring matches; secondary sort by name length.
  // Lowercase each name once (not per sort comparison) to match the backend's key= semantics.
  const lower = norm.toLowerCase();
  const matches = hits
    .map((h) => ({ h, nameLower: h.name.toLowerCase() }))
    .filter((m) => m.nameLower.includes(lower) && !m.h.code.startsWith(upper));
  matches.sort((a, b) => {
    const ap = a.nameLower.startsWith(lower) ? 0 : 1;
    const bp = b.nameLower.startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.h.name.length - b.h.name.length;
  });
  return [...codeMatches, ...matches.map((m) => m.h)].slice(0, limit);
}

export function useSymbolSearch(query: string, limit = 20): SymbolHit[] {
  const { data } = useSymbols();
  return useMemo(() => filterSymbols(data?.symbols ?? [], query, limit), [data, query, limit]);
}
