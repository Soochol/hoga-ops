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
  // Lowercase each name once (not per sort comparison) to match the backend's key= semantics.
  const lower = norm.toLowerCase();
  const matches = hits
    .map((h) => ({ h, nameLower: h.name.toLowerCase() }))
    .filter((m) => m.nameLower.includes(lower));
  matches.sort((a, b) => {
    const ap = a.nameLower.startsWith(lower) ? 0 : 1;
    const bp = b.nameLower.startsWith(lower) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    return a.h.name.length - b.h.name.length;
  });
  return matches.map((m) => m.h).slice(0, limit);
}

export function useSymbolSearch(query: string, limit = 20): SymbolHit[] {
  const { data } = useSymbols();
  return useMemo(() => filterSymbols(data?.symbols ?? [], query, limit), [data, query, limit]);
}
