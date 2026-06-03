import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getAllSymbols } from '../api/symbols';
import type { SymbolHit, SymbolsAllResponse } from '../api/types';

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const SYMBOLS_QUERY_KEY = ['symbols', 'all'] as const;

export function useSymbols() {
  return useQuery<SymbolsAllResponse>({
    queryKey: SYMBOLS_QUERY_KEY,
    queryFn: getAllSymbols,
    staleTime: ONE_DAY_MS,
  });
}

export function filterSymbols(hits: SymbolHit[], q: string, limit: number): SymbolHit[] {
  const norm = q.trim();
  if (norm.length === 0) return hits.slice(0, limit);
  if (/^\d+$/.test(norm)) {
    return hits.filter((h) => h.code.startsWith(norm)).slice(0, limit);
  }
  // Name match (case-insensitive): prefix-matches first, then substring matches; secondary sort by name length.
  const lower = norm.toLowerCase();
  const matches = hits.filter((h) => h.name.toLowerCase().includes(lower));
  matches.sort((a, b) => {
    const ap = a.name.toLowerCase().startsWith(lower) ? 0 : 1;
    const bp = b.name.toLowerCase().startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.name.length - b.name.length;
  });
  return matches.slice(0, limit);
}

export function useSymbolSearch(query: string, limit = 20): SymbolHit[] {
  const { data } = useSymbols();
  return useMemo(() => filterSymbols(data?.symbols ?? [], query, limit), [data, query, limit]);
}
