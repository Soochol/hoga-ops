import { useMemo } from 'react';
import { useWatchlist, useAddToWatchlist, useRemoveFromWatchlist } from './useWatchlist';

/**
 * Single owner of watchlist membership + toggle policy. Call ONCE per component
 * (not per row): returns an O(1) `isMember` predicate and a `toggle` that adds
 * when absent / removes when present. Used by both the single-code status bar
 * heart and the per-row search hearts.
 */
export function useWatchlistMembership() {
  const { data } = useWatchlist();
  const addM = useAddToWatchlist();
  const removeM = useRemoveFromWatchlist();
  const memberCodes = useMemo(
    () => new Set(data?.entries.map((e) => e.code) ?? []),
    [data],
  );
  const isMember = (code: string) => memberCodes.has(code);
  const toggle = (code: string) => {
    if (memberCodes.has(code)) removeM.mutate(code);
    else addM.mutate(code);
  };
  return { isMember, toggle };
}
